export type AgendaTopic = {
  id: string;
  title: string;
  prompts?: string[];
  minutes: number;
  done: boolean;
};

export type AgendaTopicInput = {
  id: string;
  title: string;
  prompts?: string[];
  minutes: number;
};

export type AgendaDefinition = {
  id: string;
  title: string;
  topics: AgendaTopicInput[];
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
