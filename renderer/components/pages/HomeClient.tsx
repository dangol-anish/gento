"use client";

import { useState } from "react";
import { Gauge, Menu, Sparkles } from "lucide-react";

import { SidebarNav } from "@/components/sidebar/SidebarNav";
import { SettingsView } from "@/components/settings/SettingsView";
import {
  Stage0Downloader,
  type Stage0Session,
} from "@/components/stage0/Stage0Downloader";
import { Stage1Extractor } from "@/components/stage1/Stage1Extractor";
import { Stage4ScriptRefiner } from "@/components/stage4/Stage4ScriptRefiner";
import { Stage5AudioGenerator } from "@/components/stage5/Stage5AudioGenerator";
import { Stage6VideoRenderer } from "@/components/stage6/Stage6VideoRenderer";
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
import { useTheme } from "@/lib/useTheme";

const STAGES = [
  "Download",
  "Extract",
  "Scenes",
  "Recap",
  "Refine",
  "Audio",
  "Video",
];

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
  const [view, setView] = useState<"pipeline" | "settings">("pipeline");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [recentChapterDirs, setRecentChapterDirs] = useState<string[]>([]);
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
          {view === "settings" ? "Settings" : "Pipeline"}
        </Badge>
      </div>

      <div className="grid min-h-[calc(100vh-6rem)] grid-cols-1 gap-5 pb-4 md:pb-5 lg:h-full lg:min-h-0 lg:grid-cols-[280px_1fr]">
        <SidebarNav
          stages={STAGES}
          activeStage={activeStage}
          setActiveStage={(stage) => {
            setView("pipeline");
            setActiveStage(stage);
          }}
          onOpenSettings={() => setView("settings")}
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
                  <Badge variant="muted">Active: {STAGES[activeStage]}</Badge>
                </CardHeader>
              </Card>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px] lg:flex-1 lg:min-h-0">
                {activeStage === 0 ? (
                  <Stage0Downloader
                    outDir="./downloads"
                    onSessionUpdate={setSessionState}
                    onDownloadComplete={(chapterDirs) => setRecentChapterDirs(chapterDirs)}
                  />
                ) : activeStage === 1 ? (
                  <Stage1Extractor
                    outDir="./output"
                    onSessionUpdate={setSessionState}
                    recentChapterDirs={recentChapterDirs}
                  />
                ) : activeStage === 2 ? (
                  <DisabledStage stageIndex={2} />
                ) : activeStage === 3 ? (
                  <DisabledStage stageIndex={3} />
                ) : activeStage === 4 ? (
                  <Stage4ScriptRefiner onSessionUpdate={setSessionState} />
                ) : activeStage === 5 ? (
                  <Stage5AudioGenerator onSessionUpdate={setSessionState} />
                ) : activeStage === 6 ? (
                  <Stage6VideoRenderer onSessionUpdate={setSessionState} />
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
                  activeStage={STAGES[activeStage]}
                  session={sessionState}
                />
              </div>
            </>
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
