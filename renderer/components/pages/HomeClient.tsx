"use client";

import { useState } from "react";
import { Gauge, Menu, Sparkles } from "lucide-react";

import { SidebarNav } from "@/components/sidebar/SidebarNav";
import { SettingsView } from "@/components/settings/SettingsView";
import { Stage0Downloader } from "@/components/stage0/Stage0Downloader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTheme } from "@/lib/useTheme";

const STAGES = ["Download", "Extract", "Scenes", "Recap", "Refine", "Audio", "Video"];

export default function HomeClient() {
  const [activeStage, setActiveStage] = useState(0);
  const [view, setView] = useState<"pipeline" | "settings">("pipeline");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();

  return (
    <main className="no-scrollbar min-h-screen overflow-y-auto px-4 pt-4 pb-4 md:px-5 md:pt-5 md:pb-5 lg:h-screen">
      <div className="mb-3 flex items-center justify-between lg:hidden">
        <Button variant="secondary" size="sm" className="gap-2" onClick={() => setSidebarOpen(true)}>
          <Menu className="h-4 w-4" />
          Navigation
        </Button>
        <Badge variant="muted">{view === "settings" ? "Settings" : "Pipeline"}</Badge>
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

        <section className="anim-enter space-y-5 pb-4 md:pb-5">
          {view === "pipeline" ? (
            <>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-5">
                  <div>
                    <CardTitle className="text-lg">Pipeline Control</CardTitle>
                    <CardDescription>Desktop orchestration for chapter processing</CardDescription>
                  </div>
                  <Badge variant="muted">Active: {STAGES[activeStage]}</Badge>
                </CardHeader>
              </Card>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
                <Stage0Downloader outDir="./downloads" />

                <Card>
                  <CardHeader className="border-b border-border/60 p-5">
                    <CardTitle>Session</CardTitle>
                    <CardDescription>Current workspace status</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3.5 p-5 text-sm text-muted-foreground">
                    <p className="flex items-center gap-2">
                      <Gauge className="h-4 w-4 text-muted-foreground" />
                      Runtime mode: Desktop preview
                    </p>
                    <p className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-muted-foreground" />
                      Design profile: glass neutral
                    </p>
                  </CardContent>
                </Card>
              </div>
            </>
          ) : (
            <SettingsView theme={theme} toggleTheme={toggleTheme} onBack={() => setView("pipeline")} />
          )}
        </section>
      </div>
    </main>
  );
}

