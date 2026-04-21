import { type StageEvent } from "./stage0";

export type Stage5Settings = {
  refinedRecapPagesPath: string;
  outDir?: string;
  outJson?: string;
  voice?: string;
  speed?: number;
  timingTts?: boolean;
};

export function buildStage5Args(params: Stage5Settings): string[] {
  const args: string[] = [params.refinedRecapPagesPath];

  if (params.outDir && params.outDir.trim()) {
    args.push("--out-dir", params.outDir.trim());
  }
  if (params.outJson && params.outJson.trim()) {
    args.push("--out-json", params.outJson.trim());
  }
  if (params.voice && params.voice.trim()) {
    args.push("--voice", params.voice.trim());
  }
  if (typeof params.speed === "number" && Number.isFinite(params.speed)) {
    args.push("--speed", String(params.speed));
  }
  if (params.timingTts) {
    args.push("--timing-tts");
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
    stitchedAudioPath: (completeEvent as any).stitched_audio_path as string | undefined,
    finalScriptPath: (completeEvent as any).final_script_path as string | undefined,
    audioDir: (completeEvent as any).audio_dir as string | undefined,
  };
}

