"use client";

import { useCallback, useRef, useState } from "react";
import { startAudioElementTranscription } from "@/lib/vosk";
import styles from "./Verify.module.css";

const MODEL_URL =
  "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz";
const DEMO_AUDIO = "/audio/interview.wav";

type TranscriptEntry = {
  id: string;
  text: string;
  timestamp: number;
};

type TranscriptionSession = {
  stop: () => void;
};

export default function VerifyPage() {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [partial, setPartial] = useState("");
  const [status, setStatus] = useState("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sessionRef = useRef<TranscriptionSession | null>(null);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setPartial("");
    setStatus("idle");
  }, []);

  const start = useCallback(async () => {
    if (!audioRef.current) {
      return;
    }

    stop();
    setEntries([]);
    sessionRef.current = await startAudioElementTranscription(
      MODEL_URL,
      audioRef.current,
      {
        onFinal: (text: string, timestamp: number) => {
          setEntries((prev) => [
            ...prev,
            { id: `${timestamp}-${prev.length}`, text, timestamp },
          ]);
        },
        onPartial: (text: string) => setPartial(text),
        onStatus: (value: string) => setStatus(value),
        onError: (error: Error) => setStatus(error.message),
      },
    );
  }, [stop]);

  return (
    <section className={styles.card}>
      <h1>Vosk Verification</h1>
      <p>
        This page plays the demo interview audio and shows the live
        transcription to validate Vosk setup.
      </p>
      <div className={styles.controls}>
        <button className={styles.button} onClick={start}>
          Start verification
        </button>
        <button className={styles.buttonSecondary} onClick={stop}>
          Stop
        </button>
      </div>
      <audio ref={audioRef} src={DEMO_AUDIO} preload="auto" />
      <div className={styles.transcript}>
        {entries.map((entry) => (
          <div key={entry.id} className={styles.entry}>
            <div className={styles.meta}>
              {new Date(entry.timestamp).toLocaleTimeString()}
            </div>
            <div>{entry.text}</div>
          </div>
        ))}
        {partial && <div>{partial}</div>}
      </div>
      <div>Status: {status}</div>
    </section>
  );
}
