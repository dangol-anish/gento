import { type StageEvent } from "./stage0";

export const STAGE1_MODEL = "ragavsachdeva/magiv3" as const;

export type Stage1Settings = {
  chapterId: string;
  imagesDir: string;
  outDir: string;
  device: "auto" | "cpu" | "mps" | "cuda";
  allowDownloads: boolean;
  debug?: boolean;
};

export function buildStage1Args(params: Stage1Settings): string[] {
  const args: string[] = [
    "--chapter-id",
    params.chapterId,
    "--images",
    params.imagesDir,
    "--out",
    params.outDir,
    "--device",
    params.device,
    "--model",
    STAGE1_MODEL,
  ];

  if (params.allowDownloads) {
    args.push("--allow-downloads");
  }
  if (params.debug) {
    args.push("--debug");
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
    storyboardPath: completeEvent.storyboard_path,
  };
}
