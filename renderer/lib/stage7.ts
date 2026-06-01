import { type StageEvent } from "./stage0";

export type Stage7Settings = {
  inputPaths: string[];
};

export function buildStage7Args(params: Stage7Settings): string[] {
  return params.inputPaths ?? [];
}

export function extractCompleteSummary(events: StageEvent[]) {
  const completeEvent = events.find((event) => event.type === "complete");
  if (!completeEvent) return null;
  return {
    outputPaths: (completeEvent as any).output_paths as string[] | undefined,
  };
}
