"use client";

import { useState } from "react";
import { Gauge, Menu, Sparkles } from "lucide-react";

import { SidebarNav } from "@/components/sidebar/SidebarNav";
import { SettingsView } from "@/components/settings/SettingsView";
import { PrerequisitesView } from "@/components/prereqs/PrerequisitesView";
import {
  Stage0Downloader,
  type Stage0Session,
} from "@/components/stage0/Stage0Downloader";
import { Stage1Extractor } from "@/components/stage1/Stage1Extractor";
import { Stage2GeminiAccuracyPass } from "@/components/stage2/Stage2GeminiAccuracyPass";
import { Stage4ScriptRefiner } from "@/components/stage4/Stage4ScriptRefiner";
import { Stage5AudioGenerator } from "@/components/stage5/Stage5AudioGenerator";
import { Stage6VideoRenderer } from "@/components/stage6/Stage6VideoRenderer";
import { Stage7JsonTrimmer } from "@/components/stage7/Stage7JsonTrimmer";
import { SessionCard } from "@/components/session/SessionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import { type PrereqReport, extractPrereqReportFromEvents } from "@/lib/prereqs";
import { useTheme } from "@/lib/useTheme";

const STAGE_LABELS: Record<number, string> = {
  0: "Download",
  1: "Extract",
  2: "Gemini",
  3: "Recap",
  4: "Refine",
  5: "Audio",
  6: "Video",
  7: "Trim",
};

const SIDEBAR_STAGES = [
  { id: 0, label: STAGE_LABELS[0] },
  { id: 1, label: STAGE_LABELS[1] },
  { id: 2, label: STAGE_LABELS[2] },
  { id: 4, label: STAGE_LABELS[4] },
  { id: 5, label: STAGE_LABELS[5] },
  { id: 6, label: STAGE_LABELS[6] },
  { id: 7, label: STAGE_LABELS[7] },
];

function getStageLabel(stageId: number) {
  return STAGE_LABELS[stageId] ?? `Stage ${stageId}`;
}

function DisabledStage({ stageIndex }: { stageIndex: number }) {
  return (
    <div className="space-y-4 rounded-3xl border border-border/60 bg-background/80 p-6 text-sm text-muted-foreground">
      <h2 className="text-base font-semibold text-foreground">
        Stage {stageIndex} is temporarily disabled
      </h2>
      <p>
        This stage UI has been commented out for now. Re-enable it in{" "}
        <span className="font-medium text-foreground">HomeClient</span> when
        ready.
      </p>
    </div>
  );
}

export default function HomeClient() {
  const [activeStage, setActiveStage] = useState(0);
  const [view, setView] = useState<"pipeline" | "settings" | "prereqs">(
    "pipeline",
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [prereqReport, setPrereqReport] = useState<PrereqReport | null>(null);
  const [prereqAutoInstall, setPrereqAutoInstall] = useState(false);
  const [isCheckingPrereqs, setIsCheckingPrereqs] = useState(false);
  const [sessionState, setSessionState] = useState<Stage0Session>({
    mangaUrl: "",
    totalChapters: 0,
    selectedChapters: 0,
    progress: 0,
    isScraping: false,
    isRunningStage: false,
    lastOutputDir: "./downloads",
    stageMessage: "Ready to scrape manga details.",
  });
  const { theme, toggleTheme } = useTheme();
  const toast = useToast();

  const handleCheckPrerequisites = async () => {
    if (!window.gento) {
      toast.error(
        "Desktop bridge unavailable",
        "Restart Electron to reload preload.",
      );
      return;
    }

    setPrereqAutoInstall(false);
    setIsCheckingPrereqs(true);

    try {
      const result = await window.gento.runStage(99, ["--mode", "check"]);
      if (!result.ok) {
        const message = formatRuntimeError(
          result.error.code,
          result.error.message,
          result.error.details,
        );
        toast.error("Prerequisite check failed", message);
        return;
      }

      const report = extractPrereqReportFromEvents(result.data.events as any);
      if (!report) {
        toast.error("Prerequisite check failed", "No report was returned.");
        return;
      }

      if (report.requirementsMet) {
        toast.success("Requirements met", "All prerequisites are installed.");
        return;
      }

      toast.push({
        title: "Prerequisites",
        message: "Some dependencies are missing — opening downloader.",
      });
      setPrereqReport(report);
      setPrereqAutoInstall(true);
      setView("prereqs");
    } finally {
      setIsCheckingPrereqs(false);
    }
  };

  return (
    <main className="no-scrollbar min-h-screen overflow-y-auto px-4 pt-4 pb-4 md:px-5 md:pt-5 md:pb-5 lg:h-screen">
      <div className="mb-3 flex items-center justify-between lg:hidden">
        <Button
          variant="secondary"
          size="sm"
          className="gap-2"
          onClick={() => setSidebarOpen(true)}
        >
          <Menu className="h-4 w-4" />
          Navigation
        </Button>
        <Badge variant="muted">
          {view === "settings"
            ? "Settings"
            : view === "prereqs"
              ? "Prerequisites"
              : "Pipeline"}
        </Badge>
      </div>

      <div className="grid min-h-[calc(100vh-6rem)] grid-cols-1 gap-5 pb-4 md:pb-5 lg:h-full lg:min-h-0 lg:grid-cols-[280px_1fr]">
        <SidebarNav
          stages={SIDEBAR_STAGES}
          activeStage={activeStage}
          setActiveStage={(stage) => {
            setView("pipeline");
            setActiveStage(stage);
          }}
          onOpenSettings={() => setView("settings")}
          onCheckPrerequisites={handleCheckPrerequisites}
          isCheckingPrerequisites={isCheckingPrereqs}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
        />
        {sidebarOpen ? (
          <button
            aria-label="Close navigation overlay"
            className="fixed inset-0 z-30 bg-black/25 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}

        <section className="anim-enter flex flex-col gap-5 pb-4 md:pb-5 lg:h-full ">
          {view === "pipeline" ? (
            <>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-5">
                  <div>
                    <CardTitle className="text-lg">Pipeline Control</CardTitle>
                    <CardDescription>
                      Desktop orchestration for chapter processing
                    </CardDescription>
                  </div>
                  <Badge variant="muted">Active: {getStageLabel(activeStage)}</Badge>
                </CardHeader>
              </Card>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px] lg:flex-1 lg:min-h-0">
                {activeStage === 0 ? (
                  <Stage0Downloader
                    outDir="./downloads"
                    onSessionUpdate={setSessionState}
                    onDownloadComplete={() => {}}
                  />
                ) : activeStage === 1 ? (
                  <Stage1Extractor
                    outDir="./output"
                    onSessionUpdate={setSessionState}
                  />
                ) : activeStage === 2 ? (
                  <Stage2GeminiAccuracyPass onSessionUpdate={setSessionState} />
                ) : activeStage === 3 ? (
                  <DisabledStage stageIndex={3} />
                ) : activeStage === 4 ? (
                  <Stage4ScriptRefiner onSessionUpdate={setSessionState} />
                ) : activeStage === 5 ? (
                  <Stage5AudioGenerator onSessionUpdate={setSessionState} />
                ) : activeStage === 6 ? (
                  <Stage6VideoRenderer onSessionUpdate={setSessionState} />
                ) : activeStage === 7 ? (
                  <Stage7JsonTrimmer onSessionUpdate={setSessionState} />
                ) : (
                  <div className="space-y-4 rounded-3xl border border-border/60 bg-background/80 p-6 text-sm text-muted-foreground">
                    <h2 className="text-base font-semibold text-foreground">Stage {activeStage} is not implemented yet</h2>
                    <p>
                      The pipeline stage is recognized, but the UI and processing logic for this stage
                      are still pending.
                    </p>
                  </div>
                )}

                <SessionCard
                  activeStage={getStageLabel(activeStage)}
                  session={sessionState}
                />
              </div>
            </>
          ) : view === "prereqs" ? (
            <PrerequisitesView
              report={prereqReport}
              autoInstall={prereqAutoInstall}
              onBack={() => {
                setPrereqAutoInstall(false);
                setView("pipeline");
              }}
              onReport={(next) => setPrereqReport(next)}
            />
          ) : (
            <SettingsView
              theme={theme}
              toggleTheme={toggleTheme}
              onBack={() => setView("pipeline")}
            />
          )}
        </section>
      </div>
    </main>
  );
}
