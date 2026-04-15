export type Chapter = { name: string; url: string };

export type StageEvent = {
  type: "progress" | "complete" | "error";
  stage: number;
  percent?: number;
  message?: string;
  chapters?: Chapter[];
  output_dir?: string;
  downloaded_chapters?: number;
};

export function extractChaptersFromEvents(events: StageEvent[]): Chapter[] {
  const completeEvents = events.filter((event) => event.type === "complete");
  return completeEvents.flatMap((event) => event.chapters || []);
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
    outputDir: completeEvent.output_dir,
    downloadedChapters: completeEvent.downloaded_chapters,
  };
}

export function buildStage0Args(params: {
  url: string;
  outDir: string;
  detailsOnly?: boolean;
  chapters?: Chapter[];
  format?: "none" | "pdf" | "cbz";
  deleteImages?: boolean;
}) {
  const args: string[] = ["--url", params.url, "--out", params.outDir];

  if (params.detailsOnly) {
    args.push("--details-only");
    return args;
  }

  if (params.chapters && params.chapters.length > 0) {
    args.push("--chapters-json", JSON.stringify(params.chapters));
  }

  args.push("--format", params.format ?? "none");

  if (params.deleteImages && (params.format === "pdf" || params.format === "cbz")) {
    args.push("--delete-images");
  }

  return args;
}

