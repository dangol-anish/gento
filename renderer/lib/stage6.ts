import { type StageEvent } from "./stage0";

export type Stage6Settings = {
  finalScriptPath: string;
  outMp4?: string;
  fps?: number;
  width?: number;
  height?: number;
  crf?: number;
  preset?: string;
  noAudio?: boolean;
  overwrite?: boolean;
};

export function buildStage6Args(params: Stage6Settings): string[] {
  const args: string[] = [params.finalScriptPath];

  if (params.outMp4 && params.outMp4.trim()) args.push("--out-mp4", params.outMp4.trim());
  if (typeof params.fps === "number" && Number.isFinite(params.fps)) args.push("--fps", String(params.fps));
  if (typeof params.width === "number" && Number.isFinite(params.width)) args.push("--width", String(params.width));
  if (typeof params.height === "number" && Number.isFinite(params.height)) args.push("--height", String(params.height));
  if (typeof params.crf === "number" && Number.isFinite(params.crf)) args.push("--crf", String(params.crf));
  if (params.preset && params.preset.trim()) args.push("--preset", params.preset.trim());
  if (params.noAudio) args.push("--no-audio");
  if (params.overwrite) args.push("--overwrite");

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
    videoPath: (completeEvent as any).video_path as string | undefined,
  };
}

