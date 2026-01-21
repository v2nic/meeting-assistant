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
