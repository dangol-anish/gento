import { useEffect, useMemo, useState } from "react";
import { FiFolder } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import { buildStage4Args, extractCompleteSummary, extractLastPercent } from "@/lib/stage4";

export type Stage4Session = {
  mangaUrl: string;
  totalChapters: number;
  selectedChapters: number;
  progress: number;
  isScraping: boolean;
  isRunningStage: boolean;
  lastOutputDir: string;
  stageMessage: string;
};

type Props = {
  onSessionUpdate?: (session: Stage4Session) => void;
};

type OutputLibrary = {
  root: string;
  mangas: Array<{
    name: string;
    path: string;
    runs: Array<{
      name: string;
      path: string;
      recap_pages_path: string | null;
      refined_recap_path: string | null;
      storyboard_path: string | null;
    }>;
  }>;
};

type QueueContext = { index: number; total: number; label: string } | null;

function normalizePosixPath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

export function Stage4ScriptRefiner({ onSessionUpdate }: Props) {
  const toast = useToast();
  const [outputRoot, setOutputRoot] = useState("./output");
  const [library, setLibrary] = useState<OutputLibrary | null>(null);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [activeMangaPath, setActiveMangaPath] = useState<string>("");
  const [runFilter, setRunFilter] = useState("");

  const [selectedRunDirs, setSelectedRunDirs] = useState<string[]>([]);
  const [jsonByRunDir, setJsonByRunDir] = useState<Record<string, string>>({});
  const [geminiPageOffset, setGeminiPageOffset] = useState(0);

  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("Ready to paste narrator JSON per chapter (Stage 4).");
  const [lastOutputDir, setLastOutputDir] = useState("./output");
  const [queueContext, setQueueContext] = useState<QueueContext>(null);

  const sessionState = useMemo<Stage4Session>(
    () => ({
      mangaUrl: outputRoot,
      totalChapters: library?.mangas.reduce((sum, manga) => sum + manga.runs.length, 0) ?? 0,
      selectedChapters: selectedRunDirs.length,
      progress,
      isScraping: false,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    }),
    [outputRoot, library, progress, isRunningStage, lastOutputDir, selectedRunDirs.length, stageMessage],
  );

  useEffect(() => {
    onSessionUpdate?.(sessionState);
  }, [onSessionUpdate, sessionState]);

  const refreshLibrary = async (nextRoot?: string) => {
    if (!window.gento?.listOutputLibrary) {
      const message = "Desktop bridge is unavailable. Restart Electron to reload preload.";
      setStageMessage(message);
      toast.error("Stage 4 unavailable", message);
      return;
    }
    setIsLoadingLibrary(true);
    try {
      const root = (nextRoot ?? outputRoot).trim() || "./output";
      const result = await window.gento.listOutputLibrary(root);
      if (!result.ok) {
        const message = formatRuntimeError(result.error.code, result.error.message, result.error.details);
        setStageMessage(message);
        toast.error("Failed to scan output", message);
        return;
      }
      setLibrary(result.data);
      setActiveMangaPath((current) => {
        if (current && result.data.mangas.some((manga) => manga.path === current)) {
          return current;
        }
        return result.data.mangas[0]?.path ?? "";
      });
      setStageMessage("Output library refreshed.");
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  useEffect(() => {
    refreshLibrary().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!window.gento?.onStageEvent) {
      return;
    }

    const unsubscribe = window.gento.onStageEvent((payload) => {
      if (!payload || payload.stage !== 4) {
        return;
      }

      if (payload.type === "progress") {
        setHasStageStarted(true);
        if (typeof payload.percent === "number") {
          setProgress(payload.percent);
        }
        if (payload.message) {
          setStageMessage(payload.message);
        }
        return;
      }

      if (payload.type === "log") {
        if (payload.message) {
          setStageMessage(payload.message);
        }
        return;
      }

      if (payload.type === "complete") {
        const outPath = payload.refined_recap_path ? payload.refined_recap_path : "";
        setProgress(100);
        setStageMessage(payload.message ?? "Stage 4 complete.");
        toast.success("Stage 4 complete", outPath ? `Wrote ${outPath}` : "Conversion finished.");
        setIsRunningStage(false);
        setHasStageStarted(false);
      }

      if (payload.type === "error") {
        const errorMessage =
          payload.error && typeof payload.error === "object"
            ? (payload.error as { message?: string }).message
            : undefined;
        setStageMessage(errorMessage || payload.message || "Stage 4 failed.");
        toast.error("Stage 4 failed", errorMessage || payload.message || "Stage 4 failed.");
        setProgress(0);
        setIsRunningStage(false);
        setHasStageStarted(false);
      }
    });

    return unsubscribe;
  }, [toast]);

  const activeManga = useMemo(() => {
    return library?.mangas.find((manga) => manga.path === activeMangaPath) ?? null;
  }, [activeMangaPath, library]);

  const visibleRuns = useMemo(() => {
    const runs = activeManga?.runs ?? [];
    const filter = runFilter.trim().toLowerCase();
    if (!filter) return runs;
    return runs.filter((run) => run.name.toLowerCase().includes(filter));
  }, [activeManga, runFilter]);

  const toggleRunSelection = (runDir: string) => {
    setSelectedRunDirs((current) => (current.includes(runDir) ? current.filter((v) => v !== runDir) : [...current, runDir]));
  };

  const removeSelectedRun = (runDir: string) => {
    setSelectedRunDirs((current) => current.filter((v) => v !== runDir));
    setJsonByRunDir((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, runDir)) return current;
      const next = { ...current };
      delete next[runDir];
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedRunDirs([]);
    setJsonByRunDir({});
  };

  const runIndexByPath = useMemo(() => {
    const map = new Map<string, { mangaName: string; runName: string; storyboardPath: string | null; refinedRecapPath: string | null }>();
    for (const manga of library?.mangas ?? []) {
      for (const run of manga.runs) {
        map.set(run.path, {
          mangaName: manga.name,
          runName: run.name,
          storyboardPath: run.storyboard_path,
          refinedRecapPath: run.refined_recap_path,
        });
      }
    }
    return map;
  }, [library]);

  const handleApplyQueue = async () => {
    if (!window.gento?.importStage4GeminiJson || !window.gento?.runStage) {
      const message = "Desktop bridge is unavailable. Restart Electron to reload preload.";
      setStageMessage(message);
      toast.error("Stage 4 unavailable", message);
      return;
    }

    const targets = selectedRunDirs
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => ({ path, meta: runIndexByPath.get(path) ?? null }));

    if (targets.length === 0) {
      setStageMessage("Select one or more chapter runs first.");
      toast.error("No chapters selected", "Select at least one final/final_x folder to paste into.");
      return;
    }

    for (const target of targets) {
      const jsonText = (jsonByRunDir[target.path] ?? "").trim();
      if (!jsonText) {
        setStageMessage(`Paste narrator JSON for ${target.path} first.`);
        toast.error("Missing JSON", `Paste narrator JSON for ${target.path}.`);
        return;
      }
      if (!target.meta?.storyboardPath) {
        setStageMessage(`Missing storyboard.json for ${target.path}. Run Stage 1 first.`);
        toast.error("Missing input", `Run Stage 1 first for ${target.path} (needs storyboard.json).`);
        return;
      }
    }

    if (isRunningStage || hasStageStarted) return;

    setIsRunningStage(true);
    setHasStageStarted(true);
    setProgress(0);
    setStageMessage("Starting Stage 4 paste queue...");

    try {
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        const meta = target.meta!;
        const label = `${meta.mangaName}/${meta.runName}`;
        setQueueContext({ index: i + 1, total: targets.length, label });
        setLastOutputDir(target.path);
        setStageMessage(`(${i + 1}/${targets.length}) Converting ${label}...`);
        setProgress(5);

        const outPath = `${normalizePosixPath(target.path)}/recap_pages_with_sentences.json`;
        const importResult = await window.gento.importStage4GeminiJson(outPath, jsonByRunDir[target.path] ?? "");
        if (!importResult.ok) {
          const message = formatRuntimeError(importResult.error.code, importResult.error.message, importResult.error.details);
          setStageMessage(message);
          toast.error("Stage 4 failed", message);
          setProgress(0);
          return;
        }

        const args = buildStage4Args({
          geminiPath: importResult.data.gemini_path,
          storyboardPath: meta.storyboardPath!,
          outPath,
          geminiPageOffset,
        });

        const result = await window.gento.runStage(4, args);
        if (!result.ok) {
          const message = formatRuntimeError(result.error.code, result.error.message, result.error.details);
          setStageMessage(message);
          toast.error("Stage 4 failed", message);
          setProgress(0);
          return;
        }

        const events = result.data?.events || [];
        const lastPercent = extractLastPercent(events);
        if (lastPercent !== null) {
          setProgress(lastPercent);
        }

        const complete = extractCompleteSummary(events);
        if (!complete?.refinedRecapPath) {
          setProgress(100);
        }
      }

      setQueueContext(null);
      setProgress(100);
      setStageMessage("Stage 4 complete: wrote recap_pages_with_sentences.json for selected chapters.");
      toast.success("Stage 4 complete", `Processed ${targets.length} chapters.`);
    } catch (error) {
      const message = (error as Error).message;
      setStageMessage(`Stage 4 failed: ${message}`);
      toast.error("Stage 4 failed", message);
      setProgress(0);
    } finally {
      setQueueContext(null);
      setIsRunningStage(false);
      setHasStageStarted(false);
    }
  };

  const handleOpenFolder = async () => {
    if (!window.gento?.openPath) {
      const message = "Desktop bridge is unavailable. Restart Electron to reload preload.";
      setStageMessage(message);
      toast.error("Open folder failed", message);
      return;
    }
    const result = await window.gento.openPath(lastOutputDir);
    if (!result.ok) {
      const message = `Failed to open folder: ${result.error.message}`;
      setStageMessage(message);
      toast.error("Open folder failed", result.error.message);
    }
  };

  return (
    <Card className="lg:flex lg:flex-col lg:min-h-0 lg:h-full">
      <CardHeader className="border-b border-border/60 p-5">
        <CardTitle>Stage 4 Narrator JSON → Gento</CardTitle>
        <CardDescription>
          Select multiple chapters (across manga) and paste your narrator JSON array per chapter. Converts it into `recap_pages_with_sentences.json` for Stage 5.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 p-5 pt-2 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Output library
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={outputRoot}
              onChange={(event) => setOutputRoot(event.target.value)}
              placeholder="./output"
              className="glass-interactive h-10 min-w-[240px] flex-1 rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
            />
            <Button
              variant="secondary"
              onClick={() => refreshLibrary(outputRoot)}
              disabled={isLoadingLibrary}
              className="shrink-0"
            >
              {isLoadingLibrary ? "Refreshing..." : "Refresh"}
            </Button>
            <Button variant="secondary" onClick={handleOpenFolder} className="gap-2 shrink-0">
              <FiFolder className="h-4 w-4" />
              Open
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Looks for `./output/&lt;manga&gt;/final*` folders. Requires `storyboard.json` (Stage 1 output) inside each selected folder.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Manga
            </label>
            <div className="glass-surface max-h-56 overflow-y-auto rounded-2xl border border-border/60 p-2">
              {library?.mangas?.length ? (
                <div className="space-y-1">
                  {library.mangas.map((manga) => (
                    <button
                      key={manga.path}
                      type="button"
                      onClick={() => setActiveMangaPath(manga.path)}
                      className={`w-full rounded-xl px-3 py-2 text-left text-sm ${
                        manga.path === activeMangaPath
                          ? "bg-accent/70 text-foreground"
                          : "hover:bg-accent/40 text-muted-foreground"
                      }`}
                    >
                      <span className="truncate">{manga.name}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  No outputs found in {outputRoot}.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Chapters {activeManga ? `(${activeManga.name})` : ""}
              </label>
              <input
                type="text"
                value={runFilter}
                onChange={(event) => setRunFilter(event.target.value)}
                placeholder="Filter…"
                className="glass-interactive h-8 w-40 rounded-xl px-3 text-xs text-foreground outline-none placeholder:text-muted-foreground border"
              />
            </div>
            <div className="glass-surface max-h-56 overflow-y-auto rounded-2xl border border-border/60 p-2">
              {activeManga?.runs?.length ? (
                <div className="space-y-1">
                  {visibleRuns.map((run) => {
                    const checked = selectedRunDirs.includes(run.path);
                    const disabled = !run.storyboard_path;
                    return (
                      <label
                        key={run.path}
                        className={`flex items-center gap-2 rounded-xl px-2 py-2 text-sm ${
                          disabled ? "opacity-60" : "cursor-pointer hover:bg-accent/40"
                        }`}
                        title={disabled ? "Missing storyboard.json (run Stage 1 first)" : run.path}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleRunSelection(run.path)}
                          className="h-4 w-4 accent-black"
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">{run.name}</span>
                        {run.refined_recap_path ? (
                          <span className="rounded-lg border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                            refined
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="px-2 py-2 text-sm text-muted-foreground">Select a manga to see chapters.</p>
              )}
            </div>
          </div>
        </div>

        {selectedRunDirs.length > 0 ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Selected chapters ({selectedRunDirs.length})
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={clearSelection}>
                  Clear selection
                </Button>
                <Button onClick={handleApplyQueue} disabled={isRunningStage || hasStageStarted} size="sm">
                  {isRunningStage || hasStageStarted ? "Converting..." : "Run Stage 4 (queue)"}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  gemini page offset
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={geminiPageOffset}
                  onChange={(event) => setGeminiPageOffset(Number(event.target.value || 0))}
                  placeholder="0"
                  className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
                />
                <div className="text-xs text-muted-foreground">
                  If you deleted the first N pages before Magi, set this to N (e.g. delete 4 pages → offset 4).
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Output pattern
                </label>
                <input
                  type="text"
                  value={`${normalizePosixPath(outputRoot)}/<manga>/final*/recap_pages_with_sentences.json`}
                  readOnly
                  className="glass-surface h-10 w-full rounded-xl px-3 text-sm text-muted-foreground outline-none border"
                />
              </div>
            </div>

            <div className="space-y-4">
              {selectedRunDirs.map((runDir) => {
                const meta = runIndexByPath.get(runDir);
                const label = meta ? `${meta.mangaName}/${meta.runName}` : runDir;
                return (
                  <div key={runDir} className="rounded-2xl border border-border/60 bg-background/60 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{label}</p>
                        <p className="truncate text-xs text-muted-foreground">{runDir}</p>
                      </div>
                      <Button variant="secondary" size="sm" onClick={() => removeSelectedRun(runDir)}>
                        Remove
                      </Button>
                    </div>
                    <textarea
                      value={jsonByRunDir[runDir] ?? ""}
                      onChange={(event) =>
                        setJsonByRunDir((current) => ({ ...current, [runDir]: event.target.value }))
                      }
                      placeholder='Paste narrator JSON array here (e.g. [{"page":1,"panels":[{"panel":1,"position":"Top Right","description":"..."}]}]).'
                      className="glass-interactive mt-3 min-h-[140px] w-full rounded-xl border px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{queueContext ? `(${queueContext.index}/${queueContext.total}) ${queueContext.label} — ${stageMessage}` : stageMessage}</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>
      </CardContent>
    </Card>
  );
}
