import { useEffect, useMemo, useState } from "react";
import { FiFolder, FiTrash2 } from "react-icons/fi";

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
import { buildStage8Args, extractCompleteSummary } from "@/lib/stage8";

export type Stage8Session = {
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
  onSessionUpdate?: (session: Stage8Session) => void;
};

function normalizePosixPath(value: string) {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/\/+$/g, "");
}

const exampleShortsJson = `{
  "manga_title": "My Manga",
  "source_chapters": ["Chapter 1", "Chapter 2"],
  "shorts": [
    {
      "beats": [
        { "narration": "It begins here.", "panel_path": "Chapter 1/panel001.png" },
        { "narration": "Then it continues.", "panel_path": "Chapter 1/panel002.png" }
      ]
    }
  ]
}`;

export function Stage8ShortsBuilder({ onSessionUpdate }: Props) {
  const toast = useToast();
  const [outputRoot, setOutputRoot] = useState("./output");
  const [shortsJsonInput, setShortsJsonInput] = useState("");
  const [shortsJsonPaths, setShortsJsonPaths] = useState<string[]>([]);
  const [pastedShortsJson, setPastedShortsJson] = useState("");
  const [voice, setVoice] = useState("am_echo");
  const [speed, setSpeed] = useState(1.0);
  const [sampleRate, setSampleRate] = useState(24000);
  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState(
    "Ready to build shorts (Stage 8).",
  );
  const [lastOutputDir, setLastOutputDir] = useState("./output");

  const sessionState = useMemo<Stage8Session>(
    () => ({
      mangaUrl: outputRoot,
      totalChapters: shortsJsonPaths.length,
      selectedChapters: shortsJsonPaths.length,
      progress,
      isScraping: false,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    }),
    [
      outputRoot,
      shortsJsonPaths.length,
      progress,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    ],
  );

  useEffect(() => {
    onSessionUpdate?.(sessionState);
  }, [onSessionUpdate, sessionState]);

  useEffect(() => {
    if (!window.gento?.onStageEvent) {
      return;
    }

    const unsubscribe = window.gento.onStageEvent((payload) => {
      if (!payload || payload.stage !== 8) {
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
        setProgress(100);
        setStageMessage(payload.message ?? "Stage 8 complete.");
        toast.success(
          "Stage 8 complete",
          "Shorts audio and assets built successfully.",
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
        setStageMessage(errorMessage || payload.message || "Stage 8 failed.");
        toast.error(
          "Stage 8 failed",
          errorMessage || payload.message || "Stage 8 failed.",
        );
        setProgress(0);
        setIsRunningStage(false);
        setHasStageStarted(false);
      }
    });

    return unsubscribe;
  }, [toast]);

  const addShortsJson = () => {
    const candidate = normalizePosixPath(shortsJsonInput);
    if (!candidate) {
      setStageMessage("Enter a shorts JSON path first.");
      return;
    }
    if (shortsJsonPaths.includes(candidate)) {
      setStageMessage("This path is already added.");
      return;
    }

    setShortsJsonPaths((current) => [...current, candidate]);
    setShortsJsonInput("");
  };

  const removeShortsJson = (index: number) => {
    setShortsJsonPaths((current) => current.filter((_, idx) => idx !== index));
  };

  const handleRunStage8Queue = async () => {
    if (!window.gento?.runStage) {
      const message =
        "Desktop bridge is unavailable. Restart Electron to reload preload.";
      setStageMessage(message);
      toast.error("Stage 8 unavailable", message);
      return;
    }

    const paths = shortsJsonPaths.map((value) => value.trim()).filter(Boolean);
    if (paths.length === 0) {
      setStageMessage("Add at least one shorts JSON file first.");
      toast.error(
        "No input files",
        "Add one or more shorts JSON paths to run Stage 8.",
      );
      return;
    }

    if (isRunningStage || hasStageStarted) return;

    setIsRunningStage(true);
    setHasStageStarted(true);
    setProgress(0);
    setStageMessage("Starting Stage 8 shorts build...");
    setLastOutputDir(outputRoot.trim() || "./output");

    try {
      const args = buildStage8Args({
        shortsJson: paths,
        outputRoot: outputRoot.trim() || undefined,
        voice: voice.trim(),
        speed,
        sampleRate,
      });

      const result = await window.gento.runStage(8, args);
      if (!result.ok) {
        const message = formatRuntimeError(
          result.error.code,
          result.error.message,
          result.error.details,
        );
        setStageMessage(message);
        toast.error("Stage 8 failed", message);
        setProgress(0);
        return;
      }

      const events = result.data?.events || [];
      const complete = extractCompleteSummary(events);
      if (complete?.outputDir) {
        setStageMessage(`Built shorts into ${complete.outputDir}`);
        setLastOutputDir(complete.outputDir);
      } else if (complete?.outputAudio) {
        setStageMessage(`Built shorts audio at ${complete.outputAudio}`);
        setLastOutputDir(outputRoot);
      } else {
        setStageMessage("Stage 8 complete.");
      }
      setProgress(100);
      toast.success("Stage 8 complete", "Shorts build finished.");
    } catch (error) {
      const message = (error as Error).message;
      setStageMessage(`Stage 8 failed: ${message}`);
      toast.error("Stage 8 failed", message);
      setProgress(0);
    } finally {
      setIsRunningStage(false);
      setHasStageStarted(false);
    }
  };

  const handleSelectOutputRoot = async () => {
    if (!window.gento?.selectFolder) {
      const message =
        "Desktop bridge is unavailable. Restart Electron to reload preload.";
      setStageMessage(message);
      toast.error("Select folder failed", message);
      return;
    }

    const result = await window.gento.selectFolder(outputRoot || undefined);
    if (!result.ok) {
      const message = result.error?.message || "Output folder selection was canceled.";
      setStageMessage(message);
      if (result.error) {
        toast.error("Select folder failed", message);
      }
      return;
    }

    setOutputRoot(result.data?.path || outputRoot);
    setLastOutputDir(result.data?.path || outputRoot);
    setStageMessage("Selected output folder.");
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
        <CardTitle>Stage 8 Shorts Builder</CardTitle>
        <CardDescription>
          Generate narration audio and collect referenced panel assets from one
          or more shorts JSON definitions.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 p-5 pt-2 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Output folder
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={outputRoot}
              readOnly
              placeholder="Select an output folder"
              className="glass-interactive h-10 min-w-[240px] flex-1 rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
            />
            <Button
              variant="secondary"
              onClick={handleSelectOutputRoot}
              className="gap-2 shrink-0"
            >
              <FiFolder className="h-4 w-4" />
              Select
            </Button>
            <Button
              variant="secondary"
              onClick={handleOpenFolder}
              className="gap-2 shrink-0"
            >
              Open
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Pick the output folder where generated shorts audio and copied panel
            assets will be written.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Shorts JSON definition
          </label>
          <p className="text-xs text-muted-foreground">
            This is a single JSON object that tells Stage 8 what text to turn into
            narration and which image panels to copy. It must contain at least:
          </p>
          <ul className="ml-4 list-disc text-xs text-muted-foreground">
            <li><code>manga_title</code>: the name of the manga.</li>
            <li><code>shorts</code>: an array of short entries.</li>
            <li>Within each short, <code>beats</code> is an array of objects.</li>
            <li>Each beat needs <code>narration</code> and <code>panel_path</code>.</li>
          </ul>
          <div className="rounded-2xl border border-border/60 bg-slate-950/5 p-3 text-xs text-muted-foreground">
            <div className="mb-2 font-medium">Example shorts JSON</div>
            <pre className="whitespace-pre-wrap rounded-xl bg-slate-950/10 p-3 text-xs">
              {exampleShortsJson}
            </pre>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={shortsJsonInput}
              onChange={(event) => setShortsJsonInput(event.target.value)}
              placeholder="Path to an existing shorts JSON file"
              className="glass-interactive h-10 min-w-[240px] flex-1 rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
            />
            <Button
              variant="secondary"
              onClick={addShortsJson}
              className="shrink-0"
            >
              Add
            </Button>
          </div>
          <div className="mt-3">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Paste shorts JSON object
            </label>
            <textarea
              value={pastedShortsJson}
              onChange={(e) => setPastedShortsJson(e.target.value)}
              placeholder='Paste the object shown above, then click "Paste & Add".'
              className="glass-interactive w-full min-h-[160px] rounded-xl px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
            />
            <div className="mt-2 flex gap-2">
              <Button
                variant="secondary"
                onClick={async () => {
                  if (!pastedShortsJson || !pastedShortsJson.trim()) {
                    setStageMessage("Paste some shorts JSON first.");
                    return;
                  }
                  if (!window.gento?.importShortsJson) {
                    const message =
                      "Desktop bridge is unavailable. Restart Electron to reload preload.";
                    setStageMessage(message);
                    toast.error("Paste & Add failed", message);
                    return;
                  }
                  try {
                    const result = await window.gento.importShortsJson(
                      outputRoot.trim() || "./output",
                      pastedShortsJson,
                    );
                    if (!result.ok) {
                      const message = formatRuntimeError(
                        result.error.code,
                        result.error.message,
                        result.error.details,
                      );
                      setStageMessage(message);
                      toast.error("Paste & Add failed", message);
                      return;
                    }
                    const pathAdded = result.data?.shorts_path;
                    if (pathAdded) {
                      setShortsJsonPaths((current) => [...current, pathAdded]);
                      setPastedShortsJson("");
                      setStageMessage(`Added pasted JSON as ${pathAdded}`);
                    }
                  } catch (error) {
                    const message = (error as Error).message;
                    setStageMessage(`Paste & Add failed: ${message}`);
                    toast.error("Paste & Add failed", message);
                  }
                }}
              >
                Paste & Add
              </Button>
              <Button
                variant="ghost"
                onClick={() => setPastedShortsJson("")}
                size="sm"
              >
                Clear
              </Button>
            </div>
          </div>
          {shortsJsonPaths.length > 0 ? (
            <div className="rounded-2xl border border-border/60 bg-background/90 p-3">
              <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground">
                <span>{shortsJsonPaths.length} file(s) added</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShortsJsonPaths([])}
                >
                  Clear
                </Button>
              </div>
              <div className="space-y-2">
                {shortsJsonPaths.map((path, index) => (
                  <div
                    key={`${path}-${index}`}
                    className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/10 px-3 py-2 text-sm"
                  >
                    <span className="truncate">{path}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeShortsJson(index)}
                      className="text-destructive"
                    >
                      <FiTrash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Add one or more shorts JSON paths to build narration audio and
              panel assets.
            </p>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Voice
            </label>
            <input
              type="text"
              value={voice}
              onChange={(event) => setVoice(event.target.value)}
              className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Speed
            </label>
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none border"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Sample rate
            </label>
            <input
              type="number"
              min="8000"
              step="1000"
              value={sampleRate}
              onChange={(event) => setSampleRate(Number(event.target.value))}
              className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none border"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={handleRunStage8Queue}
            disabled={isRunningStage || hasStageStarted}
            size="sm"
          >
            {isRunningStage || hasStageStarted
              ? "Generating..."
              : "Run Stage 8"}
          </Button>
          <div className="flex-1 min-w-0 text-sm text-muted-foreground">
            {stageMessage}
          </div>
        </div>

        <div className="space-y-3">
          <Progress value={progress} />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{progress}%</span>
            <span>{shortsJsonPaths.length} shorts file(s)</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
