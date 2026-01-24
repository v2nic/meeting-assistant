"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classifyTopic, isBrowserModelAvailable } from "@/lib/llm";
import {
  startAudioElementTranscription,
  startMicrophoneTranscription,
} from "@/lib/vosk";
import type {
  AgendaDefinition,
  AgendaTopic,
  AgendaTopicInput,
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
  totalAllocatedSeconds: number;
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

const demoAgendaDefinition: AgendaDefinition = {
  id: "demo",
  title: "Demo agenda",
  topics: [
    {
      id: "welcome",
      title: "Welcome",
      prompts: [
        "Set the tone and confirm the goal for the session.",
        "Highlight the pace and next steps.",
      ],
      minutes: 3,
    },
    {
      id: "wrap-up",
      title: "Wrap-up",
      prompts: ["Summarize decisions and confirm action items."],
      minutes: 2,
    },
  ],
};

const newAgendaTemplate: AgendaTopicInput[] = [
  {
    id: "topic-1",
    title: "Opening",
    prompts: ["Introduce the agenda and key outcomes."],
    minutes: 5,
  },
  {
    id: "topic-2",
    title: "Deep dive",
    prompts: ["Discuss the main topic in detail."],
    minutes: 15,
  },
];

const formatTime = (totalSeconds: number) => {
  const minutes = Math.floor(Math.abs(totalSeconds) / 60);
  const seconds = Math.floor(Math.abs(totalSeconds) % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const mapAgendaTopics = (agenda: AgendaDefinition) =>
  agenda.topics.map((topic) => ({ ...topic, done: false }));

const toAgendaInputs = (topics: AgendaTopic[]): AgendaTopicInput[] =>
  topics.map(({ done, ...topic }) => topic);

const toPromptText = (prompts?: string[]) => (prompts ?? []).join("\n");

const parsePromptText = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

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

type TopicProgress = {
  remainingSeconds: number;
  overtimeSeconds: number;
  started: boolean;
  totalAllocatedSeconds: number;
};

const buildInitialTopicProgress = (topics: AgendaTopic[]) =>
  topics.reduce<Record<string, TopicProgress>>((acc, topic) => {
    acc[topic.id] = {
      remainingSeconds: Math.max(0, topic.minutes * 60),
      overtimeSeconds: 0,
      started: false,
      totalAllocatedSeconds: Math.max(0, topic.minutes * 60),
    };
    return acc;
  }, {});

const buildStartTiming = (
  topic: AgendaTopic,
  carryOverSeconds: number,
  progress?: TopicProgress,
) => {
  if (progress?.started) {
    return {
      allocatedSeconds: progress.remainingSeconds,
      startingOvertimeSeconds: progress.overtimeSeconds,
      totalAllocatedSeconds: progress.totalAllocatedSeconds,
    };
  }

  const baseSeconds = Math.max(0, topic.minutes * 60);
  const startingOvertime = Math.max(0, carryOverSeconds - baseSeconds);
  const allocated = Math.max(0, baseSeconds - carryOverSeconds);

  return {
    allocatedSeconds: allocated,
    startingOvertimeSeconds: startingOvertime,
    totalAllocatedSeconds: baseSeconds,
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
    timing.totalAllocatedSeconds === 0
      ? 0
      : remaining / timing.totalAllocatedSeconds;

  return { remainingSeconds: remaining, overtimeSeconds: overtime, progress };
};

export default function MeetingAssistant() {
  const [agenda, setAgenda] = useState<AgendaTopic[]>(() =>
    mapAgendaTopics(demoAgendaDefinition),
  );
  const [agendaDefinitions, setAgendaDefinitions] = useState<
    AgendaDefinition[]
  >([]);
  const [agendaLoading, setAgendaLoading] = useState(true);
  const [agendaError, setAgendaError] = useState<string | null>(null);
  const [selectedAgendaId, setSelectedAgendaId] = useState(
    demoAgendaDefinition.id,
  );
  const [newAgendaTitle, setNewAgendaTitle] = useState("");
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<AgendaTopicInput | null>(
    null,
  );
  const [editingPrompts, setEditingPrompts] = useState("");
  const [meetingRunning, setMeetingRunning] = useState(false);
  const [currentTopicIndex, setCurrentTopicIndex] = useState(0);
  const [topicTiming, setTopicTiming] = useState<TopicTiming | null>(null);
  const [topicProgress, setTopicProgress] = useState<
    Record<string, TopicProgress>
  >({});
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

  const availableAgendas = useMemo(() => {
    const unique = new Map<string, AgendaDefinition>();
    unique.set(demoAgendaDefinition.id, demoAgendaDefinition);
    for (const definition of agendaDefinitions) {
      if (!unique.has(definition.id)) {
        unique.set(definition.id, definition);
      }
    }
    return Array.from(unique.values());
  }, [agendaDefinitions]);

  const isCreatingNew = selectedAgendaId === "new";

  const selectedAgendaDefinition = useMemo(() => {
    return (
      availableAgendas.find(
        (definition) => definition.id === selectedAgendaId,
      ) ?? demoAgendaDefinition
    );
  }, [availableAgendas, selectedAgendaId]);

  const isAgendaPersisted = useMemo(
    () =>
      agendaDefinitions.some(
        (definition) => definition.id === selectedAgendaDefinition.id,
      ),
    [agendaDefinitions, selectedAgendaDefinition.id],
  );

  const classificationSourceLabel = classificationSource
    ? classificationSource === "browser"
      ? "Browser LLM"
      : "Ollama"
    : null;

  const sessionRef = useRef<TranscriptionSession | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const classificationRef = useRef<ClassifiedTopic | null>(null);
  const classificationPendingRef = useRef(false);
  const queuedClassificationRef = useRef<TranscriptEntry[] | null>(null);
  const chimeTopicRef = useRef<string | null>(null);

  const stopTranscription = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setPartialTranscript("");
  }, []);

  useEffect(() => {
    const loadAgendas = async () => {
      try {
        setAgendaLoading(true);
        setAgendaError(null);
        const response = await fetch("/api/agendas");
        if (!response.ok) {
          throw new Error("Failed to load agendas");
        }
        const data = (await response.json()) as { agendas: AgendaDefinition[] };
        setAgendaDefinitions(data.agendas);
      } catch (error) {
        setAgendaError(
          error instanceof Error ? error.message : "Failed to load agendas",
        );
      } finally {
        setAgendaLoading(false);
      }
    };

    void loadAgendas();
  }, []);

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
  const progressFillClassName = useMemo(() => {
    if (timing.remainingSeconds <= 30) {
      return styles.progressFillAlert;
    }
    if (timing.remainingSeconds <= 60) {
      return styles.progressFillWarning;
    }
    return "";
  }, [timing.remainingSeconds]);

  const currentTopic = agenda[currentTopicIndex];
  const doneTopicIds = agenda
    .filter((topic) => topic.done)
    .map((topic) => topic.id);

  useEffect(() => {
    const nextAgenda = mapAgendaTopics(selectedAgendaDefinition);
    setAgenda(nextAgenda);
    setCurrentTopicIndex(0);
    setTopicTiming(null);
    setTopicProgress(buildInitialTopicProgress(nextAgenda));
    setClassification(null);
    setClassificationError(null);
    setTranscriptEntries([]);
    setPartialTranscript("");
    setEditingTopicId(null);
    setEditingDraft(null);
    setEditingPrompts("");
    setMeetingRunning(false);
    stopTranscription();
  }, [selectedAgendaDefinition, stopTranscription]);

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
    setTopicProgress(buildInitialTopicProgress(agenda));
  }, [agenda]);

  const persistAgenda = useCallback(
    async (nextAgenda: AgendaTopic[]) => {
      const payload = {
        id: selectedAgendaDefinition.id,
        title: selectedAgendaDefinition.title,
        topics: toAgendaInputs(nextAgenda),
      };

      if (!isAgendaPersisted) {
        const response = await fetch("/api/agendas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: selectedAgendaDefinition.title,
            topics: payload.topics,
          }),
        });
        if (!response.ok) {
          throw new Error("Failed to save agenda");
        }
        const created = (await response.json()) as AgendaDefinition;
        setAgendaDefinitions((prev) => [created, ...prev]);
        setSelectedAgendaId(created.id);
        setAgenda(mapAgendaTopics(created));
        return;
      }

      const response = await fetch(`/api/agendas/${payload.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error("Failed to save agenda");
      }
      const updated = (await response.json()) as AgendaDefinition;
      setAgendaDefinitions((prev) =>
        prev.map((definition) =>
          definition.id === updated.id ? updated : definition,
        ),
      );
    },
    [
      isAgendaPersisted,
      selectedAgendaDefinition.id,
      selectedAgendaDefinition.title,
    ],
  );

  const handleAgendaSelection = useCallback(
    (nextId: string) => {
      if (nextId === selectedAgendaId) {
        return;
      }
      setSelectedAgendaId(nextId);
    },
    [selectedAgendaId],
  );

  const handleCreateAgenda = useCallback(async () => {
    const title = newAgendaTitle.trim() || "Untitled agenda";
    const response = await fetch("/api/agendas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, topics: newAgendaTemplate }),
    });
    if (!response.ok) {
      throw new Error("Failed to create agenda");
    }
    const created = (await response.json()) as AgendaDefinition;
    setAgendaDefinitions((prev) => [created, ...prev]);
    setSelectedAgendaId(created.id);
    setAgenda(mapAgendaTopics(created));
    setNewAgendaTitle("");
  }, [newAgendaTitle]);

  const handleEditToggle = useCallback(
    (topic: AgendaTopic) => {
      if (editingTopicId === topic.id) {
        setEditingTopicId(null);
        setEditingDraft(null);
        setEditingPrompts("");
        return;
      }

      setEditingTopicId(topic.id);
      setEditingDraft({
        id: topic.id,
        title: topic.title,
        minutes: topic.minutes,
        prompts: topic.prompts,
      });
      setEditingPrompts(toPromptText(topic.prompts));
    },
    [editingTopicId],
  );

  const handleEditChange = useCallback(
    (field: "title" | "minutes", value: string) => {
      setEditingDraft((prev) => {
        if (!prev) {
          return prev;
        }
        if (field === "minutes") {
          return { ...prev, minutes: Number.parseFloat(value) || 0 };
        }
        return { ...prev, title: value };
      });
    },
    [],
  );

  const handleSaveEdit = useCallback(async () => {
    if (!editingDraft) {
      return;
    }
    const nextTopic = {
      ...editingDraft,
      prompts: parsePromptText(editingPrompts),
    };
    const nextAgenda = agenda.map((topic) =>
      topic.id === editingDraft.id ? { ...topic, ...nextTopic } : topic,
    );
    setAgenda(nextAgenda);
    setTopicProgress((prev) => {
      const current = prev[editingDraft.id];
      if (!current) {
        return prev;
      }
      const updatedRemaining = Math.max(0, nextTopic.minutes * 60);
      const remainingSeconds = current.started
        ? Math.min(current.remainingSeconds, updatedRemaining)
        : updatedRemaining;
      return {
        ...prev,
        [editingDraft.id]: {
          ...current,
          remainingSeconds,
        },
      };
    });
    setEditingTopicId(null);
    setEditingDraft(null);
    setEditingPrompts("");
    try {
      await persistAgenda(nextAgenda);
    } catch (error) {
      setAgendaError(
        error instanceof Error ? error.message : "Failed to save agenda",
      );
    }
  }, [agenda, editingDraft, editingPrompts, persistAgenda]);

  const startTopic = useCallback(
    (index: number, carryOverSeconds: number) => {
      const topic = agenda[index];
      const progress = topicProgress[topic.id];
      const {
        allocatedSeconds,
        startingOvertimeSeconds,
        totalAllocatedSeconds,
      } = buildStartTiming(topic, carryOverSeconds, progress);

      setCurrentTopicIndex(index);
      setTopicTiming({
        startMs: Date.now(),
        allocatedSeconds,
        startingOvertimeSeconds,
        totalAllocatedSeconds,
      });
      setTopicProgress((prev) => ({
        ...prev,
        [topic.id]: {
          remainingSeconds: allocatedSeconds,
          overtimeSeconds: startingOvertimeSeconds,
          started: true,
          totalAllocatedSeconds,
        },
      }));
      chimeTopicRef.current = null;

      logBrowserEvent("topic_started", {
        topicId: topic.id,
        title: topic.title,
        allocatedSeconds,
        carryOverSeconds,
      });
    },
    [agenda, topicProgress],
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

  const advanceToTopic = useCallback(
    (index: number, options?: { markCurrentDone?: boolean }) => {
      if (!meetingRunning || !topicTiming) {
        return;
      }

      const now = Date.now();
      const { remainingSeconds, overtimeSeconds } = computeTiming(
        now,
        topicTiming,
      );
      const markCurrentDone = options?.markCurrentDone ?? false;

      setTopicProgress((prev) => {
        const current = currentTopic ? prev[currentTopic.id] : undefined;
        if (!currentTopic || !current) {
          return prev;
        }
        return {
          ...prev,
          [currentTopic.id]: {
            remainingSeconds,
            overtimeSeconds,
            started: true,
            totalAllocatedSeconds: current.totalAllocatedSeconds,
          },
        };
      });

      if (markCurrentDone) {
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
      }

      startTopic(index, markCurrentDone ? overtimeSeconds : 0);
    },
    [currentTopic, currentTopicIndex, meetingRunning, startTopic, topicTiming],
  );

  const handleNextTopic = useCallback(() => {
    const nextIndex = Math.min(currentTopicIndex + 1, agenda.length - 1);
    if (nextIndex !== currentTopicIndex) {
      advanceToTopic(nextIndex, { markCurrentDone: true });
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
          advanceToTopic(nextIndex, { markCurrentDone: true });
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

  const handleCreateAgendaClick = useCallback(() => {
    void handleCreateAgenda().catch((error) => {
      setAgendaError(
        error instanceof Error ? error.message : "Failed to create agenda",
      );
    });
  }, [handleCreateAgenda]);

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

        <div className={styles.form}>
          <label className={styles.agendaMeta} htmlFor="agenda-picker">
            Agenda selection
          </label>
          <select
            id="agenda-picker"
            className={styles.input}
            value={selectedAgendaId}
            onChange={(event) => handleAgendaSelection(event.target.value)}
            data-testid="agenda-picker"
          >
            <option value="demo">Demo agenda</option>
            {availableAgendas
              .filter((definition) => definition.id !== "demo")
              .map((definition) => (
                <option key={definition.id} value={definition.id}>
                  {definition.title}
                </option>
              ))}
            <option value="new">+ New agenda</option>
          </select>
          {agendaLoading && (
            <span className={styles.agendaMeta} data-testid="agenda-loading">
              Loading agendas…
            </span>
          )}
          {agendaError && (
            <span className={styles.badge} data-testid="agenda-error">
              {agendaError}
            </span>
          )}
        </div>
        {isCreatingNew && (
          <div className={styles.form}>
            <label className={styles.agendaMeta} htmlFor="new-agenda-title">
              New agenda name
            </label>
            <div className={styles.agendaRow}>
              <input
                id="new-agenda-title"
                className={styles.input}
                placeholder="Agenda name"
                value={newAgendaTitle}
                onChange={(event) => setNewAgendaTitle(event.target.value)}
              />
              <button
                className={`${styles.button} ${styles.buttonSecondary}`}
                type="button"
                onClick={handleCreateAgendaClick}
                disabled={!newAgendaTitle.trim()}
              >
                Create
              </button>
            </div>
          </div>
        )}

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
              className={`${styles.progressFill} ${progressFillClassName}`}
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
        {!isCreatingNew && (
          <div className={styles.agendaList}>
            {agenda.map((topic, index) => {
              const isActive = index === currentTopicIndex && meetingRunning;
              const isDone = topic.done;
              const isEditing = editingTopicId === topic.id;
              return (
                <div
                  key={topic.id}
                  className={`${styles.agendaItem} ${
                    isActive ? styles.agendaItemActive : ""
                  } ${isDone ? styles.agendaItemDone : ""}`}
                  onClick={() =>
                    meetingRunning &&
                    index !== currentTopicIndex &&
                    advanceToTopic(index)
                  }
                  role="button"
                  tabIndex={0}
                  data-testid={`topic-${topic.id}`}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      meetingRunning &&
                        index !== currentTopicIndex &&
                        advanceToTopic(index);
                    }
                  }}
                >
                  <div className={styles.agendaRow}>
                    <span className={styles.agendaTitle}>{topic.title}</span>
                    <div className={styles.agendaRow}>
                      <span className={styles.agendaMeta}>
                        {topic.minutes} min
                      </span>
                      <button
                        className={styles.buttonGhost}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleEditToggle(topic);
                        }}
                        data-testid={`topic-edit-${topic.id}`}
                      >
                        {isEditing ? "Cancel" : "Edit"}
                      </button>
                    </div>
                  </div>
                  {isEditing ? (
                    <div
                      className={styles.form}
                      data-testid="topic-editor"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <input
                        className={styles.input}
                        value={editingDraft?.title ?? ""}
                        onChange={(event) =>
                          handleEditChange("title", event.target.value)
                        }
                      />
                      <input
                        className={styles.input}
                        type="number"
                        min="0"
                        step="0.25"
                        value={editingDraft?.minutes ?? 0}
                        onChange={(event) =>
                          handleEditChange("minutes", event.target.value)
                        }
                      />
                      <textarea
                        className={styles.textarea}
                        value={editingPrompts}
                        onChange={(event) =>
                          setEditingPrompts(event.target.value)
                        }
                      />
                      <button
                        className={styles.button}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleSaveEdit();
                        }}
                        data-testid={`topic-save-${topic.id}`}
                      >
                        ✓ Save
                      </button>
                    </div>
                  ) : (
                    topic.prompts &&
                    topic.prompts.length > 0 && (
                      <ul className={styles.agendaPrompts}>
                        {topic.prompts.map((prompt) => (
                          <li key={prompt} className={styles.agendaPromptItem}>
                            {prompt}
                          </li>
                        ))}
                      </ul>
                    )
                  )}
                  {isActive && (
                    <div className={styles.progressBar}>
                      <div
                        className={`${styles.progressFill} ${progressFillClassName}`}
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
        )}

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
