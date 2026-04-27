import { type StageEvent } from "./stage0";

export type Stage2GeminiSettings = {
  storyboardPath: string;
  outPath: string;
  model?: string;
  startPage?: number;
  batchSize?: number;
  timeoutSeconds?: number;
};

export function buildStage2GeminiArgs(params: Stage2GeminiSettings): string[] {
  const args = ["--storyboard", params.storyboardPath, "--out", params.outPath];

  if (params.model && params.model.trim()) {
    args.push("--model", params.model.trim());
  }

  if (typeof params.startPage === "number" && Number.isFinite(params.startPage) && params.startPage >= 1) {
    args.push("--start-page", String(Math.floor(params.startPage)));
  }

  if (typeof params.batchSize === "number" && Number.isFinite(params.batchSize) && params.batchSize > 0) {
    args.push("--batch-size", String(Math.floor(params.batchSize)));
  }

  if (typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds) && params.timeoutSeconds > 0) {
    args.push("--timeout", String(Math.floor(params.timeoutSeconds)));
  }

  return args;
}

export function extractStage2GeminiLastPercent(events: StageEvent[]): number | null {
  const progressEvents = events.filter((event) => event.type === "progress");
  const last = progressEvents.at(-1);
  return typeof last?.percent === "number" ? last.percent : null;
}

export function extractStage2GeminiCompleteSummary(events: StageEvent[]) {
  const completeEvent = events.find((event) => event.type === "complete");
  if (!completeEvent) return null;
  return {
    geminiOutputPath: (completeEvent as any).gemini_output_path as string | undefined,
  };
}
