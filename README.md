# Meeting Assistant

Meeting Assistant is a Next.js app that transcribes live audio, tracks agenda timing, and
classifies the active discussion topic against a meeting agenda. It is designed for short,
structured meetings such as interviews or standups where staying on schedule matters.

## Goals

- Provide real-time speech-to-text transcription in the browser.
- Track per-topic time remaining and overtime while the meeting runs.
- Classify conversation topics with a local browser model when available, falling back to
  a server-side Ollama-backed classifier.
- Support a demo mode that uses a generated audio file for verification and testing.

## Features

- Live transcription via Vosk Browser with microphone or demo audio input.
- Agenda editor with topic durations, progress bars, and manual topic overrides.
- Overtime tracking that rolls into the next topic to keep the schedule on track.
- Topic classification using a structured JSON response with agenda context and completed
  topics context.
- Verification page that plays demo audio to validate Vosk transcription.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

The main experience runs at `http://localhost:3000`. The verification page is available
at `http://localhost:3000/verify`.

## Demo audio

Generate the demo audio used for testing and verification:

```bash
npm run generate-audio
```

The script uses macOS `say` and `afconvert` to create `public/audio/interview.wav`.

## Dependencies

Runtime:

- Next.js 16 (App Router)
- React 19
- Vosk Browser for speech recognition
- AI SDK with OpenAI-compatible client
- Zod for request/response validation

Development:

- Playwright for end-to-end tests
- ESLint and Prettier for linting and formatting
- TypeScript for type checking

## Architecture

- `src/app/components/MeetingAssistant.tsx`: client UI, agenda state, timers, transcript,
  and topic switching logic.
- `src/lib/vosk.ts`: Vosk transcription pipeline for microphone and audio elements.
- `src/lib/llm.ts`: browser-first topic classification with API fallback.
- `src/app/api/classify/route.ts`: server-side classification endpoint using Ollama via
  the AI SDK with a heuristic fallback.
- `src/app/verify/page.tsx`: verification page that plays demo audio for transcription
  validation.
- `public/audio/interview.wav`: demo audio asset generated locally.

## Classification

The server endpoint expects an Ollama server running with an OpenAI-compatible API at
`http://localhost:11434/v1`. You can override the defaults with `OLLAMA_BASE_URL` and
`OLLAMA_API_KEY`.

## Tests

Run Playwright tests:

```bash
npm run test
```

The end-to-end test uses the demo audio source to exercise transcription and topic
classification. Ensure `npm run generate-audio` has been run at least once so the
`public/audio/interview.wav` fixture exists.
