import { type StageEvent } from "./stage0";

export type Stage4Provider = "anthropic" | "gemini";

export type Stage4Settings = {
  recapPagesPath: string;
  provider: Stage4Provider;
  model: string;
  outPath?: string;
  systemPrompt?: string;
};

export function buildStage4Args(params: Stage4Settings): string[] {
  const args: string[] = [params.recapPagesPath, "--provider", params.provider, "--model", params.model];

  if (params.outPath && params.outPath.trim()) {
    args.push("--out", params.outPath.trim());
  }

  if (params.systemPrompt && params.systemPrompt.trim()) {
    args.push("--system-prompt", params.systemPrompt.trim());
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

export type RefinedRecapPagesDoc = {
  mode: "page";
  pages: Array<{
    page_idx: number;
    recap: string;
    panels: Array<{
      sub_panel_idx: number;
      panel_id: string;
      crop_path: string;
      sentence: string;
    }>;
  }>;
};

export function validateRefinedRecapPagesJson(
  value: unknown,
): { ok: true; doc: RefinedRecapPagesDoc } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "JSON must be an object." };
  const doc = value as any;
  if (doc.mode !== "page") return { ok: false, error: "Missing mode='page'." };
  if (!Array.isArray(doc.pages) || doc.pages.length === 0) return { ok: false, error: "Missing pages[] array." };

  for (const page of doc.pages) {
    if (!page || typeof page !== "object" || typeof page.page_idx !== "number") {
      return { ok: false, error: "Each page must include page_idx (number)." };
    }
    if (typeof page.recap !== "string") return { ok: false, error: "Each page must include recap (string)." };
    if (!Array.isArray(page.panels)) return { ok: false, error: "Each page must include panels[] array." };
    for (const panel of page.panels) {
      if (!panel || typeof panel !== "object") return { ok: false, error: "Each panel must be an object." };
      if (typeof panel.sub_panel_idx !== "number") return { ok: false, error: "Each panel must include sub_panel_idx (number)." };
      if (typeof panel.panel_id !== "string" || !panel.panel_id.trim()) return { ok: false, error: "Each panel must include panel_id." };
      if (typeof panel.crop_path !== "string" || !panel.crop_path.trim()) return { ok: false, error: "Each panel must include crop_path." };
      if (typeof panel.sentence !== "string") return { ok: false, error: "Each panel must include sentence (string)." };
    }
  }

  return { ok: true, doc: doc as RefinedRecapPagesDoc };
}
