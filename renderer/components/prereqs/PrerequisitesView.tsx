"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck, ArrowLeft, Download, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import { type PrereqItem, type PrereqReport, extractPrereqReportFromEvents } from "@/lib/prereqs";

type Props = {
  report: PrereqReport | null;
  autoInstall?: boolean;
  onBack: () => void;
  onReport: (report: PrereqReport) => void;
};

function statusDot(status: PrereqItem["status"]) {
  return status === "ok" ? "bg-emerald-500/80" : "bg-rose-500/80";
}

export function PrerequisitesView({ report, autoInstall = false, onBack, onReport }: Props) {
  const toast = useToast();
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("Ready to check prerequisites.");
  const [isRunning, setIsRunning] = useState(false);

  const missing = useMemo(
    () => (report?.prereqs || []).filter((p) => p.status !== "ok"),
    [report],
  );
  const hasDownloadablesMissing = missing.some((p) => p.kind === "download");

  useEffect(() => {
    if (!window.gento?.onStageEvent) return;
    const unsubscribe = window.gento.onStageEvent((payload) => {
      if (!payload || payload.stage !== 99) return;

      if (payload.type === "progress") {
        if (typeof payload.percent === "number") setProgress(payload.percent);
        if (payload.message) setStageMessage(payload.message);
        return;
      }

      if (payload.type === "log" && payload.message) {
        setStageMessage(payload.message);
        return;
      }

      if (payload.type === "error") {
        const errorMessage =
          payload.error && typeof payload.error === "object"
            ? (payload.error as { message?: string }).message
            : undefined;
        setStageMessage(errorMessage || payload.message || "Prerequisites failed.");
        setIsRunning(false);
        return;
      }

      if (payload.type === "complete") {
        setProgress(100);
        setStageMessage(payload.message ?? "Prerequisites complete.");
        setIsRunning(false);
        return;
      }
    });

    return unsubscribe;
  }, []);

  const runStage99 = useCallback(async (args: string[]) => {
    if (!window.gento) {
      toast.error("Desktop bridge unavailable", "Restart Electron to reload preload.");
      return null;
    }

    setIsRunning(true);
    setProgress(0);
    try {
      const result = await window.gento.runStage(99, args);
      if (!result.ok) {
        const message = formatRuntimeError(result.error.code, result.error.message, result.error.details);
        toast.error("Prerequisites failed", message);
        setIsRunning(false);
        return null;
      }
      const next = extractPrereqReportFromEvents(result.data.events as any);
      if (next) onReport(next);
      if (next?.requirementsMet) {
        toast.success("Requirements met", "All prerequisites are installed.");
      }
      return next;
    } catch (error) {
      const message = (error as Error).message;
      toast.error("Prerequisites failed", message);
      setIsRunning(false);
      return null;
    }
  }, [onReport, toast]);

  const handleCheck = useCallback(async () => {
    setStageMessage("Checking prerequisites...");
    await runStage99(["--mode", "check"]);
  }, [runStage99]);

  const handleInstall = useCallback(async () => {
    setStageMessage("Downloading missing prerequisites...");
    await runStage99(["--mode", "install"]);
  }, [runStage99]);

  useEffect(() => {
    if (!autoInstall) return;
    if (!hasDownloadablesMissing) return;
    if (isRunning) return;
    void handleInstall();
  }, [autoInstall, handleInstall, hasDownloadablesMissing, isRunning]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="space-y-2 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="glass-surface flex h-11 w-11 items-center justify-center rounded-xl text-foreground">
                <ShieldCheck className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-lg">Prerequisites</CardTitle>
                <CardDescription>Check & download the dependencies Gento needs.</CardDescription>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" className="gap-2" onClick={onBack}>
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button variant="secondary" size="sm" className="gap-2" onClick={handleCheck} disabled={isRunning}>
                {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {isRunning ? "Checking..." : "Re-check"}
              </Button>
              <Button
                size="sm"
                className="gap-2"
                onClick={handleInstall}
                disabled={isRunning || !hasDownloadablesMissing}
              >
                {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {isRunning ? "Working..." : "Download missing"}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{stageMessage}</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} />
          </div>
        </CardHeader>

        <CardContent className="space-y-3 p-5">
          {report ? (
            <div className="space-y-2">
              {(report.prereqs || []).map((item) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between gap-3 rounded-2xl border border-border/60 bg-background/70 px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <div className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${statusDot(item.status)}`} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{item.label}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {item.status === "ok"
                          ? "Installed"
                          : item.kind === "download"
                            ? "Missing — can download"
                            : "Missing — manual install required"}
                      </p>
                    </div>
                  </div>
                  <div className="shrink-0 rounded-xl border border-border/60 bg-accent/50 px-2 py-1 text-[11px] text-muted-foreground">
                    {item.kind === "download" ? "Download" : "Manual"}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-border/60 bg-background/70 p-4 text-sm text-muted-foreground">
              Click <span className="font-medium text-foreground">Re-check</span> to generate a prerequisite report.
            </div>
          )}

          {missing.some((p) => p.kind === "manual") ? (
            <div className="rounded-2xl border border-border/60 bg-background/70 p-4 text-sm text-muted-foreground">
              Manual installs required: install <span className="font-medium text-foreground">ffmpeg</span> for video
              rendering, and <span className="font-medium text-foreground">Ollama</span> if you plan to use local models.
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
