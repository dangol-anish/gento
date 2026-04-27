import { type StageEvent } from "./stage0";

export type Stage2Settings = {
  storyboardPath: string;
  sceneProvider: "ollama" | "none";
  ollamaHost?: string;
  ollamaModel?: string;
  overwrite?: boolean;
  chapterContext?: string;
};

export function buildStage2Args(params: Stage2Settings): string[] {
  const args: string[] = ["--storyboard", params.storyboardPath];

  if (params.sceneProvider === "none") {
    args.push("--scene-provider", "none");
    return args;
  }

  args.push("--scene-provider", "ollama");

  if (params.ollamaHost && params.ollamaHost.trim()) {
    args.push("--ollama-host", params.ollamaHost.trim());
  }

  if (params.ollamaModel && params.ollamaModel.trim()) {
    args.push("--ollama-model", params.ollamaModel.trim());
  }

  if (params.overwrite) {
    args.push("--overwrite");
  }

  if (params.chapterContext && params.chapterContext.trim()) {
    args.push("--chapter-context", params.chapterContext.trim());
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
    storyboardPath: (completeEvent as any).storyboard_path as string | undefined,
  };
}

