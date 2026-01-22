"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classifyTopic, isBrowserModelAvailable } from "@/lib/llm";
import {
  startAudioElementTranscription,
  startMicrophoneTranscription,
} from "@/lib/vosk";
import type {
  AgendaTopic,
  ClassifiedTopic,
  ClassificationSource,
} from "@/lib/types";
import styles from "./MeetingAssistant.module.css";

type TranscriptEntry = {
  id: string;
  text: string;
  timestamp: number;
};

type TopicTiming = {
  startMs: number;
  allocatedSeconds: number;
  startingOvertimeSeconds: number;
};

type AudioSource = "microphone" | "demo";

type TranscriptionSession = {
  stop: () => void;
};

const logBrowserEvent = (event: string, payload: Record<string, unknown>) => {
  if (typeof window === "undefined") {
    return;
  }

  console.log("[meeting-assistant]", {
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};

const MODEL_URL =
  "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz";
const DEMO_AUDIO = "/audio/interview.wav";
const MAX_WORDS = 200;
const RECENT_WINDOW_MS = 2 * 60 * 1000;
const AUTO_TOPIC_CONFIDENCE = 0.8;

const defaultAgenda: AgendaTopic[] = [
  {
    id: "intro",
    title: "Intro and candidate background",
    minutes: 0.5,
    done: false,
  },
  { id: "backend", title: "Backend experience", minutes: 0.5, done: false },
  {
    id: "system",
    title: "System design discussion",
    minutes: 0.5,
    done: false,
  },
  { id: "wrap", title: "Wrap-up and questions", minutes: 0.5, done: false },
];

const formatTime = (totalSeconds: number) => {
  const minutes = Math.floor(Math.abs(totalSeconds) / 60);
  const seconds = Math.floor(Math.abs(totalSeconds) % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const buildTranscriptSlice = (entries: TranscriptEntry[]) => {
  if (entries.length === 0) {
    return "";
  }

  const now = Date.now();
  const recentEntries = entries.filter(
    (entry) => now - entry.timestamp <= RECENT_WINDOW_MS,
  );
  const sliceEntries = recentEntries.length > 0 ? recentEntries : entries;
  const transcript = sliceEntries.map((entry) => entry.text).join(" ");
  const words = transcript.split(/\s+/).filter(Boolean);

  if (words.length <= MAX_WORDS) {
    return transcript;
  }

  return words.slice(words.length - MAX_WORDS).join(" ");
};

const heuristicClassify = (
  transcript: string,
  agenda: AgendaTopic[],
  doneTopicIds: string[],
) => {
  const normalized = transcript.toLowerCase();
  const remaining = agenda.filter((topic) => !doneTopicIds.includes(topic.id));

  for (const topic of remaining) {
    const keywords = topic.title
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3);
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return {
        topicId: topic.id,
        confidence: 0.3,
        reasoning: `Matched keyword from ${topic.title}.`,
      };
    }
  }

  const fallback = remaining[0] ?? agenda[0];
  return {
    topicId: fallback?.id ?? "unknown",
    confidence: 0.1,
    reasoning: "Fallback to the next available topic.",
  };
};

const computeTiming = (nowMs: number, timing: TopicTiming | null) => {
  if (!timing) {
    return { remainingSeconds: 0, overtimeSeconds: 0, progress: 0 };
  }

  const elapsed = Math.max(0, Math.floor((nowMs - timing.startMs) / 1000));
  const remaining = Math.max(0, timing.allocatedSeconds - elapsed);
  const overtime =
    timing.startingOvertimeSeconds +
    Math.max(0, elapsed - timing.allocatedSeconds);
  const progress =
    timing.allocatedSeconds === 0 ? 0 : remaining / timing.allocatedSeconds;

  return { remainingSeconds: remaining, overtimeSeconds: overtime, progress };
};

export default function MeetingAssistant() {
  const [agenda, setAgenda] = useState<AgendaTopic[]>(defaultAgenda);
  const [meetingRunning, setMeetingRunning] = useState(false);
  const [currentTopicIndex, setCurrentTopicIndex] = useState(0);
  const [topicTiming, setTopicTiming] = useState<TopicTiming | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>(
    [],
  );
  const [partialTranscript, setPartialTranscript] = useState("");
  const [transcriptionStatus, setTranscriptionStatus] = useState("idle");
  const [classification, setClassification] = useState<ClassifiedTopic | null>(
    null,
  );
  const [classificationPending, setClassificationPending] = useState(false);
  const [classificationError, setClassificationError] = useState<string | null>(
    null,
  );
  const [classificationSource, setClassificationSource] =
    useState<ClassificationSource | null>(null);
  const [audioSource, setAudioSource] = useState<AudioSource>("microphone");

  const classificationSourceLabel = classificationSource
    ? classificationSource === "browser"
      ? "Browser LLM"
      : "Ollama"
    : null;

  const sessionRef = useRef<TranscriptionSession | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const classifyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const classificationRef = useRef<ClassifiedTopic | null>(null);
  const classificationPendingRef = useRef(false);
  const queuedClassificationRef = useRef<TranscriptEntry[] | null>(null);
  const chimeTopicRef = useRef<string | null>(null);

  useEffect(() => {
    if (!meetingRunning) {
      return;
    }

    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [meetingRunning]);

  const timing = useMemo(
    () => computeTiming(nowMs, meetingRunning ? topicTiming : null),
    [meetingRunning, nowMs, topicTiming],
  );

  const currentTopic = agenda[currentTopicIndex];
  const doneTopicIds = agenda
    .filter((topic) => topic.done)
    .map((topic) => topic.id);

  useEffect(() => {
    transcriptRef.current = transcriptEntries;
  }, [transcriptEntries]);

  useEffect(() => {
    if (!meetingRunning || transcriptEntries.length === 0) {
      return;
    }

    if (!classificationRef.current) {
      const transcriptSlice = buildTranscriptSlice(transcriptEntries);
      if (transcriptSlice) {
        setClassification({
          result: heuristicClassify(transcriptSlice, agenda, doneTopicIds),
          source: "browser",
        });
      }
    }
  }, [agenda, doneTopicIds, meetingRunning, transcriptEntries]);

  useEffect(() => {
    classificationRef.current = classification;
    setClassificationSource(classification?.source ?? null);
  }, [classification]);

  useEffect(() => {
    classificationPendingRef.current = classificationPending;
  }, [classificationPending]);

  const playTimerChime = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const AudioContextConstructor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;

    if (!AudioContextConstructor) {
      return;
    }

    const context = new AudioContextConstructor();
    const now = context.currentTime;
    const gain = context.createGain();

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
    gain.connect(context.destination);

    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.exponentialRampToValueAtTime(659, now + 0.6);
    oscillator.connect(gain);
    oscillator.start(now);
    oscillator.stop(now + 1.1);

    window.setTimeout(() => {
      void context.close();
    }, 1300);
  }, []);

  const resetAgenda = useCallback(() => {
    setAgenda((prev) => prev.map((topic) => ({ ...topic, done: false })));
  }, []);

  const startTopic = useCallback(
    (index: number, carryOverSeconds: number) => {
      const topic = agenda[index];
      const baseSeconds = Math.max(0, topic.minutes * 60);
      const startingOvertime = Math.max(0, carryOverSeconds - baseSeconds);
      const allocated = Math.max(0, baseSeconds - carryOverSeconds);

      setCurrentTopicIndex(index);
      setTopicTiming({
        startMs: Date.now(),
        allocatedSeconds: allocated,
        startingOvertimeSeconds: startingOvertime,
      });
      chimeTopicRef.current = null;

      logBrowserEvent("topic_started", {
        topicId: topic.id,
        title: topic.title,
        allocatedSeconds: allocated,
        carryOverSeconds,
      });
    },
    [agenda],
  );

  useEffect(() => {
    if (!meetingRunning || !currentTopic || !topicTiming) {
      return;
    }

    if (timing.remainingSeconds > 0) {
      return;
    }

    if (chimeTopicRef.current === currentTopic.id) {
      return;
    }

    chimeTopicRef.current = currentTopic.id;
    playTimerChime();
  }, [
    currentTopic,
    meetingRunning,
    playTimerChime,
    timing.remainingSeconds,
    topicTiming,
  ]);

  const stopTranscription = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setPartialTranscript("");
  }, []);

  const advanceToTopic = useCallback(
    (index: number) => {
      if (!meetingRunning || !topicTiming) {
        return;
      }

      const now = Date.now();
      const { overtimeSeconds } = computeTiming(now, topicTiming);

      setAgenda((prev) =>
        prev.map((topic, idx) => {
          if (idx < index) {
            return { ...topic, done: true };
          }
          if (idx === currentTopicIndex) {
            return { ...topic, done: true };
          }
          return topic;
        }),
      );

      startTopic(index, overtimeSeconds);
    },
    [currentTopicIndex, meetingRunning, startTopic, topicTiming],
  );

  const handleNextTopic = useCallback(() => {
    const nextIndex = Math.min(currentTopicIndex + 1, agenda.length - 1);
    if (nextIndex !== currentTopicIndex) {
      advanceToTopic(nextIndex);
    }
  }, [advanceToTopic, agenda.length, currentTopicIndex]);

  const runClassification = useCallback(
    async (entries: TranscriptEntry[]) => {
      if (!meetingRunning) {
        return;
      }

      if (classificationPendingRef.current) {
        queuedClassificationRef.current = entries;
        return;
      }

      const transcriptSlice = buildTranscriptSlice(entries);
      if (!transcriptSlice) {
        return;
      }

      if (!classificationRef.current) {
        setClassification({
          result: heuristicClassify(transcriptSlice, agenda, doneTopicIds),
          source: "browser",
        });
      }

      setClassificationPending(true);
      classificationPendingRef.current = true;
      setClassificationError(null);

      try {
        const result = await classifyTopic({
          transcript: transcriptSlice,
          agenda,
          doneTopicIds,
        });
        setClassification(result);

        const nextIndex = agenda.findIndex(
          (topic) => topic.id === result.result.topicId,
        );
        if (
          result.result.confidence >= AUTO_TOPIC_CONFIDENCE &&
          nextIndex >= 0 &&
          nextIndex !== currentTopicIndex &&
          !agenda[nextIndex].done
        ) {
          advanceToTopic(nextIndex);
        }
      } catch (error) {
        setClassificationError(
          error instanceof Error ? error.message : "Classification failed",
        );
      } finally {
        setClassificationPending(false);
        classificationPendingRef.current = false;
        const queuedEntries = queuedClassificationRef.current;
        if (queuedEntries) {
          queuedClassificationRef.current = null;
          void runClassification(queuedEntries);
        }
      }
    },
    [agenda, advanceToTopic, currentTopicIndex, doneTopicIds, meetingRunning],
  );

  const startTranscription = useCallback(async () => {
    stopTranscription();

    const callbacks = {
      onFinal: (text: string, timestamp: number) => {
        setTranscriptEntries((prev) => {
          const next = [
            ...prev,
            { id: `${timestamp}-${prev.length}`, text, timestamp },
          ];
          void runClassification(next);
          return next;
        });
        setPartialTranscript("");
      },
      onPartial: (text: string) => setPartialTranscript(text),
      onStatus: (status: string) => {
        setTranscriptionStatus(status);
        logBrowserEvent("transcription_status", {
          status,
          source: audioSource,
        });
      },
      onError: (error: Error) => {
        setTranscriptionStatus(`error: ${error.message}`);
        logBrowserEvent("transcription_error", {
          message: error.message,
          source: audioSource,
        });
      },
    };

    if (audioSource === "demo") {
      if (!audioRef.current) {
        return;
      }

      sessionRef.current = await startAudioElementTranscription(
        MODEL_URL,
        audioRef.current,
        callbacks,
      );
      return;
    }

    sessionRef.current = await startMicrophoneTranscription(
      MODEL_URL,
      callbacks,
    );
  }, [audioSource, runClassification, stopTranscription]);

  const handleStartMeeting = useCallback(async () => {
    resetAgenda();
    setTranscriptEntries([]);
    setClassification(null);
    setClassificationError(null);
    setMeetingRunning(true);

    logBrowserEvent("meeting_started", {
      agendaCount: agenda.length,
      audioSource,
    });
    startTopic(0, 0);
    await startTranscription();
  }, [agenda.length, audioSource, resetAgenda, startTopic, startTranscription]);

  const handleStopMeeting = useCallback(() => {
    setMeetingRunning(false);
    stopTranscription();

    logBrowserEvent("meeting_stopped", {
      transcriptEntries: transcriptRef.current.length,
    });
  }, [stopTranscription]);

  const handleAgendaChange = useCallback(
    (index: number, field: "title" | "minutes", value: string) => {
      setAgenda((prev) =>
        prev.map((topic, idx) => {
          if (idx !== index) {
            return topic;
          }

          if (field === "minutes") {
            const minutes = Number.parseFloat(value) || 0;
            return { ...topic, minutes };
          }

          return { ...topic, title: value, id: slugify(value) || topic.id };
        }),
      );
    },
    [],
  );

  const handleAddTopic = useCallback(() => {
    setAgenda((prev) => [
      ...prev,
      {
        id: `topic-${prev.length + 1}`,
        title: "New topic",
        minutes: 0.5,
        done: false,
      },
    ]);
  }, []);

  return (
    <section className={styles.container}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div>
            <h1>Meeting Assistant</h1>
            <p className={styles.subtitle}>
              Track the interview agenda, stay on time, and follow the live
              transcript.
            </p>
          </div>
          <span className={styles.badge} data-testid="model-status">
            Model: Vosk • {isBrowserModelAvailable() ? "Browser LLM" : "Ollama"}
            {classificationSourceLabel
              ? ` • Using ${classificationSourceLabel}`
              : ""}
          </span>
        </div>

        <div className={styles.controls}>
          <button
            className={styles.button}
            onClick={handleStartMeeting}
            disabled={meetingRunning}
            data-testid="start-meeting"
          >
            Start meeting
          </button>
          <button
            className={`${styles.button} ${styles.buttonSecondary}`}
            onClick={handleStopMeeting}
            disabled={!meetingRunning}
          >
            Stop meeting
          </button>
          <button
            className={`${styles.button} ${styles.buttonGhost}`}
            onClick={handleNextTopic}
            disabled={!meetingRunning || currentTopicIndex >= agenda.length - 1}
            data-testid="next-topic"
          >
            Next topic
          </button>
        </div>

        <div className={styles.timerBox}>
          <div className={styles.timerLabel}>Current topic</div>
          <div className={styles.timerValue} data-testid="timer-value">
            {timing.overtimeSeconds > 0 ? "+" : ""}
            {timing.overtimeSeconds > 0
              ? formatTime(timing.overtimeSeconds)
              : formatTime(timing.remainingSeconds)}
          </div>
          <div
            className={
              timing.overtimeSeconds > 0 ? styles.timerOvertime : undefined
            }
          >
            {timing.overtimeSeconds > 0
              ? `Overtime on ${currentTopic?.title ?? ""}`
              : `Remaining on ${currentTopic?.title ?? ""}`}
          </div>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{
                width: `${Math.max(0, Math.min(1, timing.progress)) * 100}%`,
              }}
            />
          </div>
        </div>

        <div className={styles.classificationBox}>
          <div className={styles.timerLabel}>Topic classification</div>
          {classificationPending && (
            <span className={styles.badge}>Classifying…</span>
          )}
          {classificationError && (
            <span className={styles.badge} data-testid="classification-error">
              {classificationError}
            </span>
          )}
          {classification && (
            <div>
              <div
                className={styles.agendaTitle}
                data-testid="classification-topic"
              >
                {classification.result.topicId}
              </div>
              <div className={styles.agendaMeta}>
                Confidence {Math.round(classification.result.confidence * 100)}%
                — {classification.result.reasoning}
              </div>
            </div>
          )}
        </div>

        <div className={styles.form}>
          <label className={styles.agendaMeta}>Audio source</label>
          <div className={styles.controls}>
            <button
              className={`${styles.button} ${
                audioSource === "microphone" ? "" : styles.buttonSecondary
              }`}
              onClick={() => setAudioSource("microphone")}
            >
              Microphone
            </button>
            <button
              className={`${styles.button} ${
                audioSource === "demo" ? "" : styles.buttonSecondary
              }`}
              onClick={() => setAudioSource("demo")}
            >
              Demo audio
            </button>
          </div>
          {audioSource === "demo" && (
            <audio ref={audioRef} src={DEMO_AUDIO} preload="auto" />
          )}
        </div>
      </div>

      <div className={styles.card}>
        <h2>Agenda and transcript</h2>
        <p className={styles.subtitle}>
          Click a topic to force a change. Topic time adjusts after overtime to
          stay on track.
        </p>
        <div className={styles.agendaList}>
          {agenda.map((topic, index) => {
            const isActive = index === currentTopicIndex && meetingRunning;
            const isDone = topic.done;
            return (
              <div
                key={topic.id}
                className={`${styles.agendaItem} ${
                  isActive ? styles.agendaItemActive : ""
                } ${isDone ? styles.agendaItemDone : ""}`}
                onClick={() => meetingRunning && advanceToTopic(index)}
                role="button"
                tabIndex={0}
                data-testid={`topic-${topic.id}`}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    meetingRunning && advanceToTopic(index);
                  }
                }}
              >
                <div className={styles.agendaRow}>
                  <span className={styles.agendaTitle}>{topic.title}</span>
                  <span className={styles.agendaMeta}>{topic.minutes} min</span>
                </div>
                {isActive && (
                  <div className={styles.progressBar}>
                    <div
                      className={styles.progressFill}
                      style={{
                        width: `${Math.max(0, Math.min(1, timing.progress)) * 100}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className={styles.form}>
          <h3>Edit agenda</h3>
          {agenda.map((topic, index) => (
            <div className={styles.agendaRow} key={`${topic.id}-edit`}>
              <input
                className={styles.input}
                value={topic.title}
                onChange={(event) =>
                  handleAgendaChange(index, "title", event.target.value)
                }
              />
              <input
                className={styles.input}
                type="number"
                min="0"
                step="0.25"
                value={topic.minutes}
                onChange={(event) =>
                  handleAgendaChange(index, "minutes", event.target.value)
                }
              />
            </div>
          ))}
          <button className={styles.buttonGhost} onClick={handleAddTopic}>
            Add topic
          </button>
        </div>

        <h3>Live transcript</h3>
        <div className={styles.transcript} data-testid="transcript-pane">
          {transcriptEntries.map((entry) => (
            <div
              key={entry.id}
              className={styles.transcriptItem}
              data-testid="transcript-entry"
            >
              <div className={styles.transcriptMeta}>
                {new Date(entry.timestamp).toLocaleTimeString()}
              </div>
              <div>{entry.text}</div>
            </div>
          ))}
          {partialTranscript && (
            <div className={styles.partial}>{partialTranscript}</div>
          )}
        </div>
        <div className={styles.subtitle}>
          Transcription status: {transcriptionStatus}
        </div>
      </div>
    </section>
  );
}
