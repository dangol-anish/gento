import { useEffect, useMemo, useState } from "react";
import { FiChevronDown, FiFolder } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import { buildStage6Args, extractCompleteSummary, extractLastPercent } from "@/lib/stage6";

export type Stage6Session = {
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
  onSessionUpdate?: (session: Stage6Session) => void;
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
      final_script_path: string | null;
      video_path: string | null;
    }>;
  }>;
};

type QueueContext = { index: number; total: number; label: string } | null;

function normalizePosixPath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

export function Stage6VideoRenderer({ onSessionUpdate }: Props) {
  const toast = useToast();
  const [outputRoot, setOutputRoot] = useState("./output");
  const [library, setLibrary] = useState<OutputLibrary | null>(null);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [activeMangaPath, setActiveMangaPath] = useState<string>("");
  const [runFilter, setRunFilter] = useState("");

  const [selectedRunDirs, setSelectedRunDirs] = useState<string[]>([]);

  const [fps, setFps] = useState(24);
  const [crf, setCrf] = useState(18);
  const [preset, setPreset] = useState("veryfast");
  const [transitions, setTransitions] = useState(true);
  const [transitionSeed, setTransitionSeed] = useState<number | "">("");
  const [ffmpegLoglevel, setFfmpegLoglevel] = useState<"error" | "warning" | "info">("error");
  const [overwrite, setOverwrite] = useState(false);

  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("Ready to render video (Stage 6).");
  const [lastOutputDir, setLastOutputDir] = useState("./output");
  const [queueContext, setQueueContext] = useState<QueueContext>(null);

  const sessionState = useMemo<Stage6Session>(
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
    [outputRoot, library, selectedRunDirs.length, progress, isRunningStage, lastOutputDir, stageMessage],
  );

  useEffect(() => {
    onSessionUpdate?.(sessionState);
  }, [onSessionUpdate, sessionState]);

  const refreshLibrary = async (nextRoot?: string) => {
    if (!window.gento?.listOutputLibrary) {
      const message = "Desktop bridge is unavailable. Restart Electron to reload preload.";
      setStageMessage(message);
      toast.error("Stage 6 unavailable", message);
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
    if (!window.gento?.onStageEvent) return;
    const unsubscribe = window.gento.onStageEvent((payload) => {
      if (!payload || payload.stage !== 6) return;

      if (payload.type === "progress") {
        setHasStageStarted(true);
        if (typeof payload.percent === "number") setProgress(payload.percent);
        if (payload.message) setStageMessage(payload.message);
        return;
      }

      if (payload.type === "log") {
        if (payload.message) setStageMessage(payload.message);
        return;
      }

      if (payload.type === "complete") {
        const videoPath = (payload as any).video_path as string | undefined;
        setProgress(100);
        setStageMessage(payload.message ?? "Stage 6 complete.");
        toast.success("Stage 6 complete", videoPath ? `Wrote ${videoPath}` : "Video output written.");
        setIsRunningStage(false);
        setHasStageStarted(false);
        return;
      }

      if (payload.type === "error") {
        const errorMessage =
          payload.error && typeof payload.error === "object"
            ? (payload.error as { message?: string }).message
            : undefined;
        setStageMessage(errorMessage || payload.message || "Stage 6 failed.");
        toast.error("Stage 6 failed", errorMessage || payload.message || "Stage 6 failed.");
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

  const runIndexByPath = useMemo(() => {
    const map = new Map<string, { mangaName: string; runName: string; finalScriptPath: string | null }>();
    for (const manga of library?.mangas ?? []) {
      for (const run of manga.runs) {
        map.set(run.path, {
          mangaName: manga.name,
          runName: run.name,
          finalScriptPath: run.final_script_path,
        });
      }
    }
    return map;
  }, [library]);

  const toggleRunSelection = (runDir: string) => {
    setSelectedRunDirs((current) => (current.includes(runDir) ? current.filter((v) => v !== runDir) : [...current, runDir]));
  };

  const clearSelection = () => setSelectedRunDirs([]);

  const handleRunStage6Queue = async () => {
    if (!window.gento?.runStage) {
      const message = "Desktop bridge is unavailable. Restart Electron to reload preload.";
      setStageMessage(message);
      toast.error("Stage 6 unavailable", message);
      return;
    }

    const targets = selectedRunDirs
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => ({ path, meta: runIndexByPath.get(path) ?? null }))
      .sort((a, b) => (a.meta?.mangaName ?? a.path).localeCompare(b.meta?.mangaName ?? b.path) || (a.meta?.runName ?? a.path).localeCompare(b.meta?.runName ?? b.path));

    if (targets.length === 0) {
      setStageMessage("Select one or more chapters first.");
      toast.error("No chapters selected", "Select at least one final/final_x folder to run Stage 6.");
      return;
    }

    for (const target of targets) {
      const finalScriptPath = target.meta?.finalScriptPath;
      if (!finalScriptPath) {
        setStageMessage(`Missing final_script.json for ${target.path}. Run Stage 5 first.`);
        toast.error("Missing input", `Run Stage 5 first for ${target.path} (needs final_script.json).`);
        return;
      }
    }

    if (isRunningStage || hasStageStarted) return;

    setIsRunningStage(true);
    setHasStageStarted(true);
    setProgress(0);
    setStageMessage("Starting Stage 6 render queue...");

    try {
      const allVideos: string[] = [];
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        const meta = target.meta!;
        const finalScriptPath = meta.finalScriptPath!;
        const label = `${meta.mangaName}/${meta.runName}`;
        setQueueContext({ index: i + 1, total: targets.length, label });

        setLastOutputDir(target.path);
        setProgress(5);
        setStageMessage(`(${i + 1}/${targets.length}) Rendering video for ${label}...`);

        const outMp4 = `${normalizePosixPath(target.path)}/video.mp4`;
        const args = buildStage6Args({
          finalScriptPath,
          outMp4,
          fps,
          crf,
          preset: preset.trim(),
          transitions,
          transitionSeed: transitionSeed === "" ? undefined : Number(transitionSeed),
          ffmpegLoglevel,
          overwrite,
        });

        const result = await window.gento.runStage(6, args);
        if (!result.ok) {
          const message = formatRuntimeError(result.error.code, result.error.message, result.error.details);
          setStageMessage(message);
          toast.error("Stage 6 failed", message);
          setProgress(0);
          return;
        }

        const events = result.data?.events || [];
        const lastPercent = extractLastPercent(events);
        if (lastPercent !== null) setProgress(lastPercent);

        const complete = extractCompleteSummary(events);
        if (complete?.videoPath) {
          allVideos.push(complete.videoPath);
        }
      }

      setQueueContext(null);
      setProgress(100);
      setStageMessage("Stage 6 complete.");
      toast.success("Stage 6 complete", allVideos.length ? `Wrote ${allVideos.length} videos` : "Video outputs written.");
    } catch (error) {
      const message = (error as Error).message;
      setStageMessage(`Stage 6 failed: ${message}`);
      toast.error("Stage 6 failed", message);
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
        <CardTitle>Stage 6 Video</CardTitle>
        <CardDescription>
          Select multiple chapters (across manga) and render `video.mp4` inside each chapter&apos;s `final*` folder.
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
            <Button variant="secondary" onClick={() => refreshLibrary(outputRoot)} disabled={isLoadingLibrary} className="shrink-0">
              {isLoadingLibrary ? "Refreshing..." : "Refresh"}
            </Button>
            <Button variant="secondary" onClick={handleOpenFolder} className="gap-2 shrink-0">
              <FiFolder className="h-4 w-4" />
              Open
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Select runs that already have `final_script.json` (Stage 5 output). Output is written to `final*/video.mp4`.
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
                        manga.path === activeMangaPath ? "bg-accent/70 text-foreground" : "hover:bg-accent/40 text-muted-foreground"
                      }`}
                    >
                      <span className="truncate">{manga.name}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="px-2 py-2 text-sm text-muted-foreground">No outputs found in {outputRoot}.</p>
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
                    const disabled = !run.final_script_path;
                    return (
                      <label
                        key={run.path}
                        className={`flex items-center gap-2 rounded-xl px-2 py-2 text-sm ${
                          disabled ? "opacity-60" : "cursor-pointer hover:bg-accent/40"
                        }`}
                        title={disabled ? "Missing final_script.json (run Stage 5 first)" : run.path}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleRunSelection(run.path)}
                          className="h-4 w-4 accent-black"
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">{run.name}</span>
                        {run.video_path ? (
                          <span className="rounded-lg border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                            rendered
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

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">FPS</label>
            <input
              type="number"
              value={fps}
              min={1}
              max={120}
              onChange={(event) => setFps(Number(event.target.value))}
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">CRF</label>
            <input
              type="number"
              value={crf}
              min={0}
              max={40}
              onChange={(event) => setCrf(Number(event.target.value))}
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            />
          </div>

          <div className="space-y-2 lg:col-span-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preset</label>
            <input
              type="text"
              value={preset}
              onChange={(event) => setPreset(event.target.value)}
              placeholder="veryfast"
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            />
          </div>

          <div className="space-y-2 lg:col-span-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Transitions</label>
            <div className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-background/70 p-4">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={transitions}
                  onChange={(event) => setTransitions(event.target.checked)}
                />
                Enable random pan/zoom per panel
              </label>

              <div className="grid gap-2 lg:grid-cols-2">
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Seed (optional)</div>
                  <input
                    type="number"
                    value={transitionSeed}
                    onChange={(event) => {
                      const raw = event.target.value;
                      setTransitionSeed(raw === "" ? "" : Number(raw));
                    }}
                    disabled={!transitions}
                    placeholder="Leave blank for random"
                    className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none disabled:opacity-60"
                  />
                </div>
                <div className="text-xs text-muted-foreground self-end">
                  Uses zoom in/out and pan left/right, up/down.
                </div>
              </div>

              <div className="grid gap-2 lg:grid-cols-2">
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">ffmpeg logs</div>
                  <div className="relative">
                    <select
                      value={ffmpegLoglevel}
                      onChange={(event) => setFfmpegLoglevel(event.target.value as "error" | "warning" | "info")}
                      className="glass-interactive h-10 w-full appearance-none rounded-xl border pl-3 pr-10 text-sm text-foreground outline-none"
                    >
                      <option value="error">Errors only</option>
                      <option value="warning">Warnings</option>
                      <option value="info">Info (verbose)</option>
                    </select>
                    <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </div>
                <div className="text-xs text-muted-foreground self-end">
                  If the render looks stuck, set this to “Info” to see ffmpeg output in the stage log.
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(event) => setOverwrite(event.target.checked)}
                />
                Overwrite existing segments/output (restart from beginning)
              </label>
            </div>
          </div>
        </div>

        {selectedRunDirs.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Selected chapters ({selectedRunDirs.length})
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={clearSelection}>
                Clear selection
              </Button>
              <Button onClick={handleRunStage6Queue} disabled={isRunningStage || hasStageStarted} size="sm">
                {isRunningStage || hasStageStarted ? "Rendering..." : "Run Stage 6 (queue)"}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="space-y-2 rounded-2xl border border-border/60 bg-background/70 p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {queueContext ? `(${queueContext.index}/${queueContext.total}) ${queueContext.label} — ${stageMessage}` : stageMessage}
            </span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>
      </CardContent>
    </Card>
  );
}
