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

export function Stage4ScriptRefiner({ onSessionUpdate }: Props) {
  const toast = useToast();
  const [geminiPath, setGeminiPath] = useState("./output/final/gemini_output");
  const [geminiJsonText, setGeminiJsonText] = useState("");
  const [storyboardPath, setStoryboardPath] = useState("./output/final/storyboard.json");
  const [outPath, setOutPath] = useState("./output/final/recap_pages_with_sentences.json");
  const [geminiPageOffset, setGeminiPageOffset] = useState(0);

  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("Ready to convert Gemini narrator JSON into recap_pages_with_sentences.json (Stage 4).");
  const [lastOutputDir, setLastOutputDir] = useState("./output/final");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!window.gento?.pathExists) {
        return;
      }
      const baseDir = storyboardPath.trim().replaceAll("\\", "/");
      const folder = baseDir.includes("/") ? baseDir.slice(0, baseDir.lastIndexOf("/")) : "./output/final";
      const candidates = [
        `${folder}/gemini_output`,
        `${folder}/gemini_output.json`,
        `${folder}/gemini_narrator.json`,
      ];
      for (const candidate of candidates) {
        const result = await window.gento.pathExists(candidate);
        if (!result.ok) continue;
        if (cancelled) return;
        if (result.data.exists) {
          setGeminiPath(candidate);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storyboardPath]);

  useEffect(() => {
    const raw = outPath.trim();
    if (!raw) return;
    const normalized = raw.replaceAll("\\", "/");
    const folderGuess = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : normalized;
    setLastOutputDir(folderGuess || "./output/final");
  }, [outPath]);

  const sessionState = useMemo<Stage4Session>(
    () => ({
      mangaUrl: storyboardPath,
      totalChapters: 0,
      selectedChapters: 0,
      progress,
      isScraping: false,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    }),
    [isRunningStage, lastOutputDir, progress, stageMessage, storyboardPath],
  );

  useEffect(() => {
    onSessionUpdate?.(sessionState);
  }, [onSessionUpdate, sessionState]);

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
        return;
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
  }, []);

  const handleFormatGeminiJson = () => {
    const raw = geminiJsonText.trim();
    if (!raw) {
      setStageMessage("Paste Gemini narrator JSON first.");
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const formatted = JSON.stringify(parsed, null, 2);
      setGeminiJsonText(formatted);
      setStageMessage("Gemini JSON formatted.");
    } catch (error) {
      const message = `Invalid JSON: ${(error as Error).message}`;
      setStageMessage(message);
      toast.error("Format failed", message);
    }
  };

  const handleRunStage4 = async () => {
    if (!storyboardPath.trim()) {
      setStageMessage("Please provide the storyboard.json path.");
      return;
    }
    if (!outPath.trim()) {
      setStageMessage("Please provide the output path for recap_pages_with_sentences.json.");
      return;
    }
    const hasPastedGemini = Boolean(geminiJsonText.trim());
    if (!hasPastedGemini && !geminiPath.trim()) {
      setStageMessage("Provide a Gemini narrator JSON path or paste the JSON.");
      return;
    }
    if (!window.gento || typeof window.gento.runStage !== "function") {
      setStageMessage("Desktop bridge is unavailable. Restart Electron to reload preload.");
      return;
    }
    if (isRunningStage || hasStageStarted) {
      return;
    }

    setIsRunningStage(true);
    setHasStageStarted(true);
    setProgress(5);
    setStageMessage("Starting Stage 4 conversion...");

    try {
      let resolvedGeminiPath = geminiPath.trim();
      if (hasPastedGemini) {
        if (!window.gento.importStage4GeminiJson) {
          const message = "Pasted JSON is unsupported (missing preload bridge). Restart Electron to reload preload.";
          setStageMessage(message);
          toast.error("Stage 4 failed", message);
          setProgress(0);
          return;
        }
        setStageMessage("Saving pasted Gemini JSON...");
        const importResult = await window.gento.importStage4GeminiJson(outPath.trim(), geminiJsonText);
        if (!importResult.ok) {
          const message = formatRuntimeError(importResult.error.code, importResult.error.message, importResult.error.details);
          setStageMessage(message);
          toast.error("Stage 4 failed", message);
          setProgress(0);
          return;
        }
        resolvedGeminiPath = importResult.data.gemini_path;
      }

      const args = buildStage4Args({
        geminiPath: resolvedGeminiPath,
        storyboardPath: storyboardPath.trim(),
        outPath: outPath.trim(),
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
      if (complete?.refinedRecapPath) {
        setProgress(100);
        setStageMessage(`Stage 4 complete: ${complete.refinedRecapPath}`);
        toast.success("Stage 4 complete", `Wrote ${complete.refinedRecapPath}`);
        return;
      }

      setProgress(100);
      setStageMessage("Stage 4 finished.");
      toast.success("Stage 4 complete", "Conversion finished.");
    } catch (error) {
      const message = (error as Error).message;
      setStageMessage(`Stage 4 failed: ${message}`);
      toast.error("Stage 4 failed", message);
      setProgress(0);
    } finally {
      setIsRunningStage(false);
      setHasStageStarted(false);
    }
  };

  const handleOpenFolder = async () => {
    if (!window.gento?.openPath) {
      setStageMessage("Desktop bridge is unavailable. Restart Electron to reload preload.");
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
        <CardTitle>Stage 4 Gemini → Gento</CardTitle>
        <CardDescription>
          Convert your Gemini narrator JSON into `recap_pages_with_sentences.json` for Stage 5 audio.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 p-5 pt-2 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            gemini narrator json path
          </label>
          <input
            type="text"
            value={geminiPath}
            onChange={(event) => setGeminiPath(event.target.value)}
            placeholder="./output/final/gemini_narrator.json"
            disabled={Boolean(geminiJsonText.trim())}
            className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border disabled:opacity-60"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              gemini narrator json (paste)
            </label>
            <Button variant="secondary" onClick={handleFormatGeminiJson} className="rounded-xl" disabled={!geminiJsonText.trim()}>
              Format JSON
            </Button>
          </div>
          <textarea
            value={geminiJsonText}
            onChange={(event) => setGeminiJsonText(event.target.value)}
            placeholder='Paste the Gemini narrator JSON array here (e.g. [{"page":1,"panels":[...]}]).'
            className="glass-interactive min-h-[180px] w-full rounded-xl border px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="text-xs text-muted-foreground">
            If this textarea is non-empty, Stage 4 uses it and ignores the path input.
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            storyboard.json path
          </label>
          <input
            type="text"
            value={storyboardPath}
            onChange={(event) => setStoryboardPath(event.target.value)}
            placeholder="./output/final/storyboard.json"
            className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            output path
          </label>
          <input
            type="text"
            value={outPath}
            onChange={(event) => setOutPath(event.target.value)}
            placeholder="./output/final/recap_pages_with_sentences.json"
            className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
          />
        </div>

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
            If you deleted the first N pages before running Magi, set this to N (e.g. delete 4 pages → offset 4).
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleRunStage4} disabled={isRunningStage} className="rounded-xl">
            Run Stage 4
          </Button>
          <Button variant="secondary" onClick={handleOpenFolder} className="gap-2 rounded-xl">
            <FiFolder className="h-4 w-4" />
            Open folder
          </Button>
          <div className="text-xs text-muted-foreground">No API key needed (uses your saved Gemini chat JSON).</div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{stageMessage}</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>
      </CardContent>
    </Card>
  );
}
