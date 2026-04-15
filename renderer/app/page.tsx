"use client";

import { useEffect, useMemo, useState } from "react";
import { Clapperboard, Gauge, Menu, Moon, Settings, Sparkles, Sun, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

const stages = ["Download", "Extract", "Scenes", "Recap", "Refine", "Audio", "Video"];

export default function Home() {
  const [activeStage, setActiveStage] = useState(0);
  const [progress, setProgress] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [view, setView] = useState<"pipeline" | "settings">("pipeline");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const applyTheme = (nextTheme: "light" | "dark") => {
    setTheme(nextTheme);
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
    document.documentElement.setAttribute("data-theme", nextTheme);
    window.localStorage.setItem("gento-theme", nextTheme);
  };

  useEffect(() => {
    const saved = window.localStorage.getItem("gento-theme");
    const nextTheme = saved === "dark" ? "dark" : "light";
    applyTheme(nextTheme);
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
  };

  const status = useMemo(() => {
    if (progress === 0) return { label: "Idle", variant: "muted" as const };
    if (progress < 100) return { label: "Running", variant: "warning" as const };
    return { label: "Complete", variant: "success" as const };
  }, [progress]);

  return (
    <main className="h-screen overflow-hidden p-4 md:p-5">
      <div className="mb-3 flex items-center justify-between lg:hidden">
        <Button variant="secondary" size="sm" className="gap-2" onClick={() => setSidebarOpen(true)}>
          <Menu className="h-4 w-4" />
          Navigation
        </Button>
        <Badge variant="muted">{view === "settings" ? "Settings" : "Pipeline"}</Badge>
      </div>

      <div className="grid h-[calc(100%-3rem)] grid-cols-1 gap-5 lg:h-full lg:grid-cols-[280px_1fr]">
        <Card
          className={`fixed inset-y-4 left-4 z-40 w-[280px] flex-col justify-between transition-transform duration-200 lg:static lg:z-auto lg:flex lg:w-auto lg:translate-x-0 ${
            sidebarOpen ? "flex translate-x-0" : "hidden"
          } ${sidebarOpen ? "anim-drawer" : ""}`}
        >
          <CardHeader className="space-y-5 border-b border-border/60 p-5">
            <div className="flex items-center justify-between lg:hidden">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Navigation</p>
              <Button variant="ghost" size="sm" onClick={() => setSidebarOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex items-center gap-2.5">
              <div className="glass-surface flex h-11 w-11 items-center justify-center rounded-xl text-foreground">
                <Clapperboard className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-sm font-semibold">Gento</CardTitle>
                <CardDescription className="text-xs">Manga Video Studio</CardDescription>
              </div>
            </div>
            <div className="space-y-2">
              {stages.map((stage, index) => (
                <button
                  key={stage}
                  type="button"
                  onClick={() => {
                    setView("pipeline");
                    setActiveStage(index);
                    setSidebarOpen(false);
                  }}
                  className={`anim-press flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
                    activeStage === index
                      ? "glass-interactive text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                  }`}
                >
                  <span>{stage}</span>
                  <span
                    className={`h-2 w-2 rounded-full ${activeStage === index ? "bg-primary" : "bg-muted-foreground/45"}`}
                  />
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-2.5 p-5">
            <Button
              variant="secondary"
              className="w-full justify-start gap-2"
              onClick={() => {
                setView("settings");
                setSidebarOpen(false);
              }}
            >
              <Settings className="h-4 w-4" />
              Settings
            </Button>
          </CardContent>
        </Card>

        {sidebarOpen ? (
          <button
            aria-label="Close navigation overlay"
            className="fixed inset-0 z-30 bg-black/25 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}

        <section className="anim-enter space-y-5">
          {view === "pipeline" ? (
            <>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-5">
                  <div>
                    <CardTitle className="text-lg">Pipeline Control</CardTitle>
                    <CardDescription>Desktop orchestration for chapter processing</CardDescription>
                  </div>
                  <Badge variant={status.variant}>{status.label}</Badge>
                </CardHeader>
              </Card>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
                <Card>
                  <CardHeader className="border-b border-border/60 p-5">
                    <CardTitle>Stage 0 Smoke Test</CardTitle>
                    <CardDescription>Validate interactions before pipeline integration.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5 p-5">
                    <Progress value={progress} />
                    <p className="text-sm text-muted-foreground/90">
                      Active stage: <span className="text-foreground">{stages[activeStage]}</span>
                    </p>
                    <div className="flex gap-3">
                      <Button onClick={() => setProgress((v) => (v >= 100 ? 0 : Math.min(100, v + 25)))}>
                        Run Stage Stub
                      </Button>
                      <Button variant="secondary" onClick={() => setProgress(0)}>
                        Reset
                      </Button>
                    </div>
                  </CardContent>
                </Card>

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
                      Design profile: macOS utility
                    </p>
                    <p className="flex items-center gap-2">
                      <Clapperboard className="h-4 w-4 text-muted-foreground" />
                      Next target: live stage IPC binding
                    </p>
                  </CardContent>
                </Card>
              </div>
            </>
          ) : (
            <Card>
              <CardHeader className="border-b border-border/60 p-5">
                <CardTitle className="text-lg">Settings</CardTitle>
                <CardDescription>Application appearance and behavior controls.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 p-5">
                <div className="glass-surface flex items-center justify-between rounded-xl px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Theme</p>
                    <p className="text-xs text-muted-foreground">
                      Switch between light and dark workspace themes.
                    </p>
                  </div>
                  <Button variant="secondary" onClick={toggleTheme} className="gap-2">
                    {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                    {theme === "dark" ? "Light Mode" : "Dark Mode"}
                  </Button>
                </div>
                <Button variant="ghost" onClick={() => setView("pipeline")}>
                  Back to Pipeline
                </Button>
              </CardContent>
            </Card>
          )}
        </section>
      </div>
    </main>
  );
}
