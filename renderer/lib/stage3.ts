import { type StageEvent } from "./stage0";

export type Stage3Mode = "page" | "panel";

export type Stage3Settings = {
  storyboardPath: string;
  mode: Stage3Mode;
  sentencesMin: number;
  sentencesMax: number;
  contextPages: number;
  ollamaHost: string;
  ollamaModel: string;
  overwrite?: boolean;
};

export function buildStage3Args(params: Stage3Settings): string[] {
  const args: string[] = [
    params.storyboardPath,
    "--mode",
    params.mode,
    "--sentences-min",
    String(params.sentencesMin),
    "--sentences-max",
    String(params.sentencesMax),
    "--context-pages",
    String(params.contextPages),
    "--ollama-host",
    params.ollamaHost,
    "--ollama-model",
    params.ollamaModel,
  ];

  if (params.overwrite) {
    args.push("--overwrite");
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
    recapPath: (completeEvent as any).recap_path as string | undefined,
    skipped: Boolean((completeEvent as any).skipped),
  };
}
