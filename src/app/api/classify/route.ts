import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import type { AgendaTopic } from "@/lib/types";

const inputSchema = z.object({
  transcript: z.string().min(1),
  agenda: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      minutes: z.number(),
      done: z.boolean(),
    }),
  ),
  doneTopicIds: z.array(z.string()),
});

const outputSchema = z.object({
  topicId: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const heuristicClassify = (
  agenda: AgendaTopic[],
  doneTopicIds: string[],
  transcript: string,
) => {
  const remaining = agenda.filter((topic) => !doneTopicIds.includes(topic.id));
  const normalized = transcript.toLowerCase();

  for (const topic of remaining) {
    const keywords = topic.title
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3);
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return {
        topicId: topic.id,
        confidence: 0.42,
        reasoning: `Matched keyword from ${topic.title}.`,
      };
    }
  }

  const fallback = remaining[0] ?? agenda[0];
  return {
    topicId: fallback?.id ?? "unknown",
    confidence: 0.2,
    reasoning: "Fallback to the next available topic.",
  };
};

const buildPrompt = (
  agenda: AgendaTopic[],
  doneTopicIds: string[],
  transcript: string,
) => {
  const agendaLines = agenda
    .map((topic) => `${topic.id}: ${topic.title} (${topic.minutes}m)`)
    .join("\n");
  const doneText = doneTopicIds.length > 0 ? doneTopicIds.join(", ") : "none";

  return [
    "Agenda:",
    agendaLines,
    `Topics done: ${doneText}`,
    "Transcript:",
    transcript,
    "Return JSON only with topicId, confidence, and reasoning.",
  ].join("\n");
};

export async function POST(request: Request) {
  try {
    const body = inputSchema.parse(await request.json());

    const openai = createOpenAI({
      baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
      apiKey: process.env.OLLAMA_API_KEY ?? "ollama",
      compatibility: "compatible",
    });

    try {
      const result = await generateObject({
        model: openai("llama3.2:1b", { structuredOutputs: true }),
        schema: outputSchema,
        system:
          "You classify meeting transcripts into agenda topics. Only use topic IDs from the agenda.",
        prompt: buildPrompt(body.agenda, body.doneTopicIds, body.transcript),
      });

      return Response.json(result.object);
    } catch {
      return Response.json(
        heuristicClassify(body.agenda, body.doneTopicIds, body.transcript),
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Classification failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
