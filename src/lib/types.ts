export type AgendaTopic = {
  id: string;
  title: string;
  minutes: number;
  done: boolean;
};

export type ClassificationResult = {
  topicId: string;
  confidence: number;
  reasoning: string;
};

export type ClassificationSource = "browser" | "ollama";

export type ClassifiedTopic = {
  result: ClassificationResult;
  source: ClassificationSource;
};
