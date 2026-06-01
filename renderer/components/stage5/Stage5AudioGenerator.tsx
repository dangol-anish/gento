import { useEffect, useMemo, useState } from "react";
import { FiFolder } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import {
  buildStage5Args,
  extractCompleteSummary,
  extractLastPercent,
} from "@/lib/stage5";

export type Stage5Session = {
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
  onSessionUpdate?: (session: Stage5Session) => void;
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

export function Stage5AudioGenerator({ onSessionUpdate }: Props) {
  const toast = useToast();
  const [outputRoot, setOutputRoot] = useState("./output");
  const [library, setLibrary] = useState<OutputLibrary | null>(null);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [activeMangaPath, setActiveMangaPath] = useState<string>("");
  const [runFilter, setRunFilter] = useState("");

  const [selectedRunDirs, setSelectedRunDirs] = useState<string[]>([]);

  const [voice, setVoice] = useState("am_echo");
  const [speed, setSpeed] = useState(1.0);
  const [timingTts, setTimingTts] = useState(false);

  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState(
    "Ready to generate audio (Stage 5).",
  );
  const [lastOutputDir, setLastOutputDir] = useState("./output");
  const [queueContext, setQueueContext] = useState<QueueContext>(null);

  const sessionState = useMemo<Stage5Session>(
    () => ({
      mangaUrl: outputRoot,
      totalChapters:
        library?.mangas.reduce((sum, manga) => sum + manga.runs.length, 0) ?? 0,
      selectedChapters: selectedRunDirs.length,
      progress,
      isScraping: false,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    }),
    [
      outputRoot,
      library,
      selectedRunDirs.length,
      progress,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    ],
  );

  useEffect(() => {
    onSessionUpdate?.(sessionState);
  }, [onSessionUpdate, sessionState]);

  const refreshLibrary = async (nextRoot?: string) => {
    if (!window.gento?.listOutputLibrary) {
      const message =
        "Desktop bridge is unavailable. Restart Electron to reload preload.";
      setStageMessage(message);
      toast.error("Stage 5 unavailable", message);
      return;
    }
    setIsLoadingLibrary(true);
    try {
      const root = (nextRoot ?? outputRoot).trim() || "./output";
      const result = await window.gento.listOutputLibrary(root);
      if (!result.ok) {
        const message = formatRuntimeError(
          result.error.code,
          result.error.message,
          result.error.details,
        );
        setStageMessage(message);
        toast.error("Failed to scan output", message);
        return;
      }
      setLibrary(result.data);
      setActiveMangaPath((current) => {
        if (
          current &&
          result.data.mangas.some((manga) => manga.path === current)
        ) {
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
      if (!payload || payload.stage !== 5) {
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
        const outScript = payload.final_script_path
          ? payload.final_script_path
          : "";
        const outAudio = payload.stitched_audio_path
          ? payload.stitched_audio_path
          : "";
        setProgress(100);
        setStageMessage(payload.message ?? "Stage 5 complete.");
        toast.success(
          "Stage 5 complete",
          outScript
            ? `Wrote ${outScript}`
            : outAudio
              ? `Wrote ${outAudio}`
              : "Audio outputs written.",
        );
        setIsRunningStage(false);
        setHasStageStarted(false);
        return;
      }

      if (payload.type === "error") {
        const errorMessage =
          payload.error && typeof payload.error === "object"
            ? (payload.error as { message?: string }).message
            : undefined;
        setStageMessage(errorMessage || payload.message || "Stage 5 failed.");
        toast.error(
          "Stage 5 failed",
          errorMessage || payload.message || "Stage 5 failed.",
        );
        setProgress(0);
        setIsRunningStage(false);
        setHasStageStarted(false);
      }
    });

    return unsubscribe;
  }, [toast]);

  const activeManga = useMemo(() => {
    return (
      library?.mangas.find((manga) => manga.path === activeMangaPath) ?? null
    );
  }, [activeMangaPath, library]);

  const visibleRuns = useMemo(() => {
    const runs = activeManga?.runs ?? [];
    const filter = runFilter.trim().toLowerCase();
    if (!filter) return runs;
    return runs.filter((run) => run.name.toLowerCase().includes(filter));
  }, [activeManga, runFilter]);

  const runIndexByPath = useMemo(() => {
    const map = new Map<
      string,
      { mangaName: string; runName: string; refinedRecapPath: string | null }
    >();
    for (const manga of library?.mangas ?? []) {
      for (const run of manga.runs) {
        map.set(run.path, {
          mangaName: manga.name,
          runName: run.name,
          refinedRecapPath: run.refined_recap_path,
        });
      }
    }
    return map;
  }, [library]);

  const toggleRunSelection = (runDir: string) => {
    setSelectedRunDirs((current) =>
      current.includes(runDir)
        ? current.filter((v) => v !== runDir)
        : [...current, runDir],
    );
  };

  const clearSelection = () => setSelectedRunDirs([]);

  const handleRunStage5Queue = async () => {
    if (!window.gento?.runStage) {
      const message =
        "Desktop bridge is unavailable. Restart Electron to reload preload.";
      setStageMessage(message);
      toast.error("Stage 5 unavailable", message);
      return;
    }

    const targets = selectedRunDirs
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => ({ path, meta: runIndexByPath.get(path) ?? null }))
      .sort(
        (a, b) =>
          (a.meta?.mangaName ?? a.path).localeCompare(
            b.meta?.mangaName ?? b.path,
          ) ||
          (a.meta?.runName ?? a.path).localeCompare(b.meta?.runName ?? b.path),
      );

    if (targets.length === 0) {
      setStageMessage("Select one or more chapters first.");
      toast.error(
        "No chapters selected",
        "Select at least one final/final_x folder to run Stage 5.",
      );
      return;
    }

    for (const target of targets) {
      const refinedRecapPath = target.meta?.refinedRecapPath;
      if (!refinedRecapPath) {
        setStageMessage(
          `Missing recap_pages_with_sentences.json for ${target.path}. Run Stage 4 first.`,
        );
        toast.error(
          "Missing input",
          `Run Stage 4 first for ${target.path} (needs recap_pages_with_sentences.json).`,
        );
        return;
      }
    }

    if (isRunningStage || hasStageStarted) return;

    setIsRunningStage(true);
    setHasStageStarted(true);
    setProgress(0);
    setStageMessage("Starting Stage 5 audio queue...");

    try {
      const allFinalScripts: string[] = [];
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        const meta = target.meta!;
        const refinedRecapPath = meta.refinedRecapPath!;
        const label = `${meta.mangaName}/${meta.runName}`;
        setQueueContext({ index: i + 1, total: targets.length, label });

        const refinedDir = normalizePosixPath(refinedRecapPath).includes("/")
          ? normalizePosixPath(refinedRecapPath).slice(
              0,
              normalizePosixPath(refinedRecapPath).lastIndexOf("/"),
            )
          : target.path;
        setLastOutputDir(`${refinedDir}/audio`);

        setProgress(5);
        setStageMessage(
          `(${i + 1}/${targets.length}) Generating audio for ${label}...`,
        );

        const args = buildStage5Args({
          refinedRecapPagesPath: refinedRecapPath,
          voice: voice.trim(),
          speed,
          timingTts,
        });

        console.log("Stage 5 args:", args);

        console.log("⏱️ Stage 5 START:", new Date().toISOString());
        const timerStart = performance.now();

        const result = await window.gento.runStage(5, args);

        // Timer ends here FIRST
        const timerEnd = performance.now();
        console.log("⏱️ Stage 5 END:", new Date().toISOString());
        console.log(
          `⏱️ Stage 5 took: ${((timerEnd - timerStart) / 1000).toFixed(2)} seconds`,
        );

        if (!result.ok) {
          const message = formatRuntimeError(
            result.error.code,
            result.error.message,
            result.error.details,
          );
          setStageMessage(message);
          toast.error("Stage 5 failed", message);
          setProgress(0);
          return;
        }

        const events = result.data?.events || [];
        const lastPercent = extractLastPercent(events);
        if (lastPercent !== null) {
          setProgress(lastPercent);
        }
        const complete = extractCompleteSummary(events);
        if (complete?.finalScriptPath) {
          allFinalScripts.push(complete.finalScriptPath);
        }
      }

      setQueueContext(null);
      setProgress(100);
      setStageMessage("Stage 5 complete.");
      toast.success(
        "Stage 5 complete",
        allFinalScripts.length
          ? `Wrote ${allFinalScripts.length} final_script.json files`
          : "Audio outputs written.",
      );
    } catch (error) {
      const message = (error as Error).message;
      setStageMessage(`Stage 5 failed: ${message}`);
      toast.error("Stage 5 failed", message);
      setProgress(0);
    } finally {
      setQueueContext(null);
      setIsRunningStage(false);
      setHasStageStarted(false);
    }
  };

  const handleOpenFolder = async () => {
    if (!window.gento?.openPath) {
      const message =
        "Desktop bridge is unavailable. Restart Electron to reload preload.";
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
        <CardTitle>Stage 5 Audio</CardTitle>
        <CardDescription>
          Select multiple chapters (across manga) and generate audio into each
          chapter&apos;s own `final*/audio` folder.
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
            <Button
              variant="secondary"
              onClick={handleOpenFolder}
              className="gap-2 shrink-0"
            >
              <FiFolder className="h-4 w-4" />
              Open
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Select runs that already have `recap_pages_with_sentences.json`
            (Stage 4 output). Audio stays under each run folder.
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
                    const disabled = !run.refined_recap_path;
                    return (
                      <label
                        key={run.path}
                        className={`flex items-center gap-2 rounded-xl px-2 py-2 text-sm ${
                          disabled
                            ? "opacity-60"
                            : "cursor-pointer hover:bg-accent/40"
                        }`}
                        title={
                          disabled
                            ? "Missing recap_pages_with_sentences.json (run Stage 4 first)"
                            : run.path
                        }
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleRunSelection(run.path)}
                          className="h-4 w-4 accent-black"
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {run.name}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  Select a manga to see chapters.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Voice
            </label>
            <input
              type="text"
              value={voice}
              onChange={(event) => setVoice(event.target.value)}
              placeholder="am_echo"
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Speed
            </label>
            <input
              type="number"
              value={speed}
              step={0.05}
              min={0.5}
              max={2.0}
              onChange={(event) => setSpeed(Number(event.target.value))}
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={timingTts}
            onChange={(event) => setTimingTts(event.target.checked)}
            className="h-4 w-4"
          />
          Generate timing TTS per panel (slower, improves sync)
        </label>

        {selectedRunDirs.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Selected chapters ({selectedRunDirs.length})
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={clearSelection}>
                Clear selection
              </Button>
              <Button
                onClick={handleRunStage5Queue}
                disabled={isRunningStage || hasStageStarted}
                size="sm"
              >
                {isRunningStage || hasStageStarted
                  ? "Generating..."
                  : "Run Stage 5 (queue)"}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {queueContext
                ? `(${queueContext.index}/${queueContext.total}) ${queueContext.label} — ${stageMessage}`
                : stageMessage}
            </span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>
      </CardContent>
    </Card>
  );
}
