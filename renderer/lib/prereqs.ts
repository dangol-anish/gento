export type PrereqStatus = "ok" | "missing";
export type PrereqKind = "download" | "manual";

export type PrereqItem = {
  id: string;
  label: string;
  status: PrereqStatus;
  kind: PrereqKind;
  details?: unknown;
};

export type PrereqReport = {
  requirementsMet: boolean;
  prereqs: PrereqItem[];
  message?: string;
};

type StageEvent = {
  type: "progress" | "complete" | "error" | "log";
  stage?: number;
  message?: string;
  requirements_met?: boolean;
  prereqs?: PrereqItem[];
};

export function extractPrereqReportFromEvents(events: StageEvent[]): PrereqReport | null {
  const complete = events.find((evt) => evt.type === "complete" && evt.stage === 99);
  if (!complete) return null;
  if (typeof complete.requirements_met !== "boolean") return null;
  return {
    requirementsMet: complete.requirements_met,
    prereqs: Array.isArray(complete.prereqs) ? complete.prereqs : [],
    message: complete.message,
  };
}

