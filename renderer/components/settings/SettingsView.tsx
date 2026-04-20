import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { type ThemeMode } from "@/lib/theme";

type Props = {
  theme: ThemeMode;
  toggleTheme: () => void;
  onBack: () => void;
};

export function SettingsView({ theme, toggleTheme, onBack }: Props) {
  const toast = useToast();
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [hasAnthropicApiKey, setHasAnthropicApiKey] = useState(false);
  const [hasGeminiApiKey, setHasGeminiApiKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!window.gento?.getAppSettings) return;
      const result = await window.gento.getAppSettings();
      if (!result.ok) return;
      if (cancelled) return;
      setHasAnthropicApiKey(Boolean(result.data.hasAnthropicApiKey));
      setHasGeminiApiKey(Boolean(result.data.hasGeminiApiKey));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    if (!window.gento?.setAppSettings) {
      toast.error("Settings unavailable", "Restart Electron to reload preload.");
      return;
    }
    setIsSaving(true);
    try {
      const patch: { anthropicApiKey?: string; geminiApiKey?: string } = {};
      if (anthropicApiKey.trim()) patch.anthropicApiKey = anthropicApiKey.trim();
      if (geminiApiKey.trim()) patch.geminiApiKey = geminiApiKey.trim();
      const result = await window.gento.setAppSettings(patch);
      if (!result.ok) {
        toast.error("Save failed", result.error.message);
        return;
      }
      setHasAnthropicApiKey(Boolean(result.data.hasAnthropicApiKey));
      setHasGeminiApiKey(Boolean(result.data.hasGeminiApiKey));
      setAnthropicApiKey("");
      setGeminiApiKey("");
      toast.success("Saved", "API keys updated for Stage 4.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    if (!window.gento?.setAppSettings) {
      toast.error("Settings unavailable", "Restart Electron to reload preload.");
      return;
    }
    setIsSaving(true);
    try {
      const result = await window.gento.setAppSettings({ anthropicApiKey: "", geminiApiKey: "" });
      if (!result.ok) {
        toast.error("Clear failed", result.error.message);
        return;
      }
      setHasAnthropicApiKey(false);
      setHasGeminiApiKey(false);
      toast.success("Cleared", "API keys removed.");
    } finally {
      setIsSaving(false);
    }
  };

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

        <div className="glass-surface space-y-3 rounded-xl px-4 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">Stage 4 API Keys</p>
            <p className="text-xs text-muted-foreground">
              Stored locally on this machine and injected into Stage 4 as environment variables.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Anthropic (Claude) API key {hasAnthropicApiKey ? "(saved)" : "(not set)"}
              </label>
              <input
                type="password"
                value={anthropicApiKey}
                onChange={(e) => setAnthropicApiKey(e.target.value)}
                placeholder={hasAnthropicApiKey ? "Enter to replace…" : "sk-ant-…"}
                className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Gemini API key {hasGeminiApiKey ? "(saved)" : "(not set)"}
              </label>
              <input
                type="password"
                value={geminiApiKey}
                onChange={(e) => setGeminiApiKey(e.target.value)}
                placeholder={hasGeminiApiKey ? "Enter to replace…" : "AIza…"}
                className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={handleSave} disabled={isSaving || (!anthropicApiKey.trim() && !geminiApiKey.trim())}>
              Save keys
            </Button>
            <Button variant="ghost" onClick={handleClear} disabled={isSaving || (!hasAnthropicApiKey && !hasGeminiApiKey)}>
              Clear saved keys
            </Button>
          </div>
        </div>

        <Button variant="ghost" onClick={onBack}>
          Back to Pipeline
        </Button>
      </CardContent>
    </Card>
  );
}
