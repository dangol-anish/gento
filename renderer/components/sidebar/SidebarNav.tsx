import { Clapperboard, Settings, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Props = {
  stages: string[];
  activeStage: number;
  setActiveStage: (stage: number) => void;
  onOpenSettings: () => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
};

const DISABLED_STAGE_INDICES = new Set([2, 3]);

export function SidebarNav({
  stages,
  activeStage,
  setActiveStage,
  onOpenSettings,
  sidebarOpen,
  setSidebarOpen,
}: Props) {
  return (
    <Card
      className={`fixed inset-y-4 left-4 z-40 w-[280px] flex-col justify-between transition-transform duration-200 lg:static lg:z-auto lg:flex lg:w-auto lg:translate-x-0 lg:self-start lg:mb-5 ${
        sidebarOpen ? "flex translate-x-0 anim-drawer" : "hidden"
      }`}
    >
      <CardHeader className="space-y-5 border-b border-border/60 p-5">
        <div className="flex items-center justify-between lg:hidden">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Navigation
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="glass-surface flex h-11 w-11 items-center justify-center rounded-xl text-foreground">
            <Clapperboard className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-sm font-semibold">Gento</CardTitle>
            <CardDescription className="text-xs">
              Manga Video Studio
            </CardDescription>
          </div>
        </div>

        <div className="space-y-2">
          {stages.map((stage, index) => {
            const isDisabled = DISABLED_STAGE_INDICES.has(index);
            return (
              <button
                key={stage}
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  if (isDisabled) return;
                  setActiveStage(index);
                  setSidebarOpen(false);
                }}
                className={`anim-press flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
                  isDisabled
                    ? "cursor-not-allowed border-transparent text-muted-foreground/60 opacity-60"
                    : activeStage === index
                      ? "text-black dark:text-white border-black/10 shadow-xs shadow-black/10"
                      : "border-transparent text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                }`}
              >
                <span>{stage}</span>
                <span
                  className={`h-2 w-2 rounded-full ${
                    activeStage === index && !isDisabled
                      ? "bg-primary"
                      : "bg-muted-foreground/45"
                  }`}
                />
              </button>
            );
          })}
        </div>
      </CardHeader>

      <CardContent className="space-y-2.5 p-5">
        <Button
          variant="secondary"
          className="w-full justify-start gap-2"
          onClick={() => {
            onOpenSettings();
            setSidebarOpen(false);
          }}
        >
          <Settings className="h-4 w-4" />
          Settings
        </Button>
      </CardContent>
    </Card>
  );
}
