import { type StageEvent } from "./stage0";

export type Stage8Settings = {
  shortsJson: string[];
  outputRoot?: string;
  voice?: string;
  speed?: number;
  sampleRate?: number;
};

export function buildStage8Args(params: Stage8Settings): string[] {
  const args: string[] = [...(params.shortsJson ?? [])];

  if (params.outputRoot && params.outputRoot.trim()) {
    args.push("--output-root", params.outputRoot.trim());
  }
  if (params.voice && params.voice.trim()) {
    args.push("--voice", params.voice.trim());
  }
  if (typeof params.speed === "number" && Number.isFinite(params.speed)) {
    args.push("--speed", String(params.speed));
  }
  if (typeof params.sampleRate === "number" && Number.isFinite(params.sampleRate)) {
    args.push("--sample-rate", String(params.sampleRate));
  }

  return args;
}

export function extractCompleteSummary(events: StageEvent[]) {
  const completeEvent = events.find((event) => event.type === "complete");
  if (!completeEvent) return null;

  return {
    outputAudio: (completeEvent as any).output_audio as string | undefined,
    outputDir: (completeEvent as any).output_dir as string | undefined,
    copiedPanels: (completeEvent as any).copied_panels as string[] | undefined,
    missingPanelPaths: (completeEvent as any).missing_panel_paths as string[] | undefined,
  };
}
