import { type StageEvent } from "./stage0";

export type Stage4Settings = {
  geminiPath: string;
  storyboardPath: string;
  outPath: string;
  geminiPageOffset?: number;
};

export function buildStage4Args(params: Stage4Settings): string[] {
  const args = [
    "--gemini",
    params.geminiPath,
    "--storyboard",
    params.storyboardPath,
    "--out",
    params.outPath,
  ];

  if (typeof params.geminiPageOffset === "number" && Number.isFinite(params.geminiPageOffset) && params.geminiPageOffset !== 0) {
    args.push("--gemini-page-offset", String(params.geminiPageOffset));
  }

  return args;
}

export function extractLastPercent(events: StageEvent[]): number | null {
  const progressEvents = events.filter((event) => event.type === "progress");
  const last = progressEvents.at(-1);
  return typeof last?.percent === "number" ? last.percent : null;
}

export function extractCompleteSummary(events: StageEvent[]) {
  const completeEvent = events.find((event) => event.type === "complete");
  if (!completeEvent) return null;
  return {
    refinedRecapPath: (completeEvent as any).refined_recap_path as string | undefined,
  };
}

export type Stage4OutputSummary = {
  refinedRecapPath?: string;
};
