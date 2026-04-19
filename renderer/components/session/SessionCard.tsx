import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CheckCircle2,
  Download,
  Folder,
  Gauge,
  List,
  Sparkles,
} from "lucide-react";

export type SessionCardProps = {
  activeStage: string;
  session: {
    mangaUrl: string;
    totalChapters: number;
    selectedChapters: number;
    progress: number;
    isScraping: boolean;
    isRunningStage: boolean;
    lastOutputDir: string;
    stageMessage: string;
  };
};

export function SessionCard({ activeStage, session }: SessionCardProps) {
  const statusLabel = session.isRunningStage
    ? "Downloading"
    : session.isScraping
      ? "Scraping"
      : "Idle";

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between border-b border-border/60 p-5">
        <div>
          <CardTitle>Session</CardTitle>
          <CardDescription>Current workspace status</CardDescription>
        </div>
        <Badge
          variant="muted"
          className="w-fit px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.05em]"
        >
          {statusLabel}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3 p-5 py- text-sm text-muted-foreground">
        <div className="grid gap-3">
          <div className="flex items-center gap-2 rounded-2xl border border-border/50 bg-background/80 px-3 py-2">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                Active stage
              </p>
              <p className="font-medium text-foreground">{activeStage}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-2xl border border-border/50 bg-background/80 px-3 py-2">
            <List className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                Chapters
              </p>
              <p className="font-medium text-foreground">
                {session.selectedChapters}/{session.totalChapters} selected
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-2xl border border-border/50 bg-background/80 px-3 py-2">
            <Download className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                Progress
              </p>
              <p className="font-medium text-foreground">{session.progress}%</p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 rounded-2xl border border-border/50 bg-background/80 p-3">
          <div className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-foreground">Last update</span>
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            {session.stageMessage}
          </p>
        </div>

        <div className="grid gap-3 rounded-2xl border border-border/50 bg-background/80 p-3">
          <div className="flex items-center gap-2 text-sm">
            <Folder className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-foreground">Download folder</span>
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {session.lastOutputDir}
          </p>
        </div>

        <div className="rounded-2xl border border-border/50 bg-background/80 p-3">
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-foreground">Input path</span>
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {session.mangaUrl || "No input path provided"}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
