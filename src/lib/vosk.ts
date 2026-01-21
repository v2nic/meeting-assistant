import { createModel, type KaldiRecognizer, type Model } from "vosk-browser";

type VoskStatus = "idle" | "loading" | "listening" | "error";

type VoskCallbacks = {
  onFinal: (text: string, timestamp: number) => void;
  onPartial: (text: string) => void;
  onStatus: (status: VoskStatus) => void;
  onError: (error: Error) => void;
};

type MicrophoneSession = {
  stop: () => void;
};

type AudioElementSession = {
  stop: () => void;
};

const modelCache = new Map<string, Promise<Model>>();

const createError = (error: unknown, fallback: string) =>
  error instanceof Error ? error : new Error(fallback);

const getModel = async (modelUrl: string) => {
  if (!modelCache.has(modelUrl)) {
    modelCache.set(modelUrl, createModel(modelUrl));
  }
  return modelCache.get(modelUrl) as Promise<Model>;
};

const attachRecognizerHandlers = (
  recognizer: KaldiRecognizer,
  callbacks: VoskCallbacks,
) => {
  recognizer.on("result", (message) => {
    if (message.event !== "result") {
      return;
    }

    const text = message.result.text.trim();
    if (text) {
      callbacks.onFinal(text, Date.now());
    }
  });

  recognizer.on("partialresult", (message) => {
    if (message.event !== "partialresult") {
      return;
    }

    callbacks.onPartial(message.result.partial ?? "");
  });
};

export const startMicrophoneTranscription = async (
  modelUrl: string,
  callbacks: VoskCallbacks,
): Promise<MicrophoneSession> => {
  callbacks.onStatus("loading");

  const model = await getModel(modelUrl);
  const mediaStream = await navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1,
    },
  });

  const audioContext = new AudioContext();
  const recognizer = new model.KaldiRecognizer(audioContext.sampleRate);
  recognizer.setWords(true);
  attachRecognizerHandlers(recognizer, callbacks);

  const source = audioContext.createMediaStreamSource(mediaStream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event) => {
    try {
      recognizer.acceptWaveform(event.inputBuffer);
    } catch (error) {
      callbacks.onError(createError(error, "acceptWaveform failed"));
      callbacks.onStatus("error");
    }
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  callbacks.onStatus("listening");

  return {
    stop: () => {
      mediaStream.getTracks().forEach((track) => track.stop());
      source.disconnect();
      processor.disconnect();
      recognizer.remove();
      void audioContext.close();
      callbacks.onStatus("idle");
    },
  };
};

export const startAudioElementTranscription = async (
  modelUrl: string,
  audioElement: HTMLAudioElement,
  callbacks: VoskCallbacks,
): Promise<AudioElementSession> => {
  callbacks.onStatus("loading");
  const model = await getModel(modelUrl);
  const audioContext = new AudioContext();
  const recognizer = new model.KaldiRecognizer(audioContext.sampleRate);
  recognizer.setWords(true);
  attachRecognizerHandlers(recognizer, callbacks);

  const source = audioContext.createMediaElementSource(audioElement);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event) => {
    try {
      recognizer.acceptWaveform(event.inputBuffer);
    } catch (error) {
      callbacks.onError(createError(error, "acceptWaveform failed"));
      callbacks.onStatus("error");
    }
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  await audioElement.play();
  callbacks.onStatus("listening");

  return {
    stop: () => {
      audioElement.pause();
      source.disconnect();
      processor.disconnect();
      recognizer.remove();
      void audioContext.close();
      callbacks.onStatus("idle");
    },
  };
};
