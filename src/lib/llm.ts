import type { AgendaTopic, ClassificationResult } from "./types";

export type ClassificationInput = {
  transcript: string;
  agenda: AgendaTopic[];
  doneTopicIds: string[];
};

type BrowserLanguageModel = {
  generate: (options: {
    prompt: string;
  }) => Promise<{ response?: string } | string>;
};

type BrowserLanguageModelApi = {
  languageModel?: {
    create: (options?: { system?: string }) => Promise<BrowserLanguageModel>;
  };
};

const systemPrompt =
  "You classify meeting transcripts into agenda topics. Return strict JSON with topicId, confidence (0-1), and reasoning.";

const buildPrompt = (input: ClassificationInput) => {
  const agendaText = input.agenda
    .map((topic) => `${topic.id}: ${topic.title} (${topic.minutes}m)`)
    .join("\n");
  const doneText = input.doneTopicIds.length
    ? input.doneTopicIds.join(", ")
    : "none";

  return [
    "Agenda:",
    agendaText,
    `Topics done: ${doneText}`,
    "Transcript:",
    input.transcript.trim(),
    "Respond with JSON only.",
  ].join("\n");
};

const safeJsonParse = (value: string) => {
  try {
    return JSON.parse(value) as ClassificationResult;
  } catch {
    return null;
  }
};

const tryLocalClassification = async (
  input: ClassificationInput,
): Promise<ClassificationResult | null> => {
  const ai = (globalThis as { ai?: BrowserLanguageModelApi }).ai;
  if (!ai?.languageModel?.create) {
    return null;
  }

  const model = await ai.languageModel.create({ system: systemPrompt });
  const result = await model.generate({ prompt: buildPrompt(input) });
  const text = typeof result === "string" ? result : (result.response ?? "");
  const parsed = safeJsonParse(text);
  if (!parsed) {
    return null;
  }

  return parsed;
};

export const classifyTopic = async (
  input: ClassificationInput,
): Promise<ClassificationResult> => {
  const localResult = await tryLocalClassification(input);
  if (localResult) {
    return localResult;
  }

  const response = await fetch("/api/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error("Classification failed");
  }

  return (await response.json()) as ClassificationResult;
};
