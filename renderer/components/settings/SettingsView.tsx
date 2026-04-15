import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ThemeMode } from "@/lib/theme";

type Props = {
  theme: ThemeMode;
  toggleTheme: () => void;
  onBack: () => void;
};

export function SettingsView({ theme, toggleTheme, onBack }: Props) {
  return (
    <Card>
      <CardHeader className="border-b border-border/60 p-5">
        <CardTitle className="text-lg">Settings</CardTitle>
        <CardDescription>Application appearance and behavior controls.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-5">
        <div className="glass-surface flex items-center justify-between rounded-xl px-4 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">Theme</p>
            <p className="text-xs text-muted-foreground">Switch between light and dark workspace themes.</p>
          </div>
          <Button variant="secondary" onClick={toggleTheme} className="gap-2">
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {theme === "dark" ? "Light Mode" : "Dark Mode"}
          </Button>
        </div>
        <Button variant="ghost" onClick={onBack}>
          Back to Pipeline
        </Button>
      </CardContent>
    </Card>
  );
}

