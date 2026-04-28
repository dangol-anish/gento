export {};

type GentoError = {
  code: string;
  message: string;
  details?: unknown;
};

type GentoSuccess<T> = { ok: true; data: T; error: null };
type GentoFailure = { ok: false; data: null; error: GentoError };
type GentoResult<T> = GentoSuccess<T> | GentoFailure;

type AppSettingsSummary = {
  hasAnthropicApiKey: boolean;
  hasGeminiApiKey: boolean;
};

type StageEvent = {
  type: "progress" | "complete" | "error" | "log";
  stage?: number;
  percent?: number;
  message?: string;
  requirements_met?: boolean;
  prereqs?: Array<{
    id: string;
    label: string;
    status: "ok" | "missing";
    kind: "download" | "manual";
    details?: unknown;
  }>;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  chapters?: Array<{ name: string; url: string }>;
  manga_metadata?: Record<string, unknown>;
  output_dir?: string;
  downloaded_chapters?: number;
  chapter_dirs?: string[];
  storyboard_path?: string;
  storyboard_paths?: string[];
  recap_path?: string;
  gemini_output_path?: string;
  final_script_path?: string;
  refined_recap_path?: string;
  stitched_audio_path?: string;
  audio_dir?: string;
  video_path?: string;
  imported?: boolean;
};

declare global {
  interface Window {
    gento: {
      runStage: (stage: number, args?: string[]) => Promise<GentoResult<{ events: StageEvent[] }>>;
      getAppSettings: () => Promise<GentoResult<AppSettingsSummary>>;
      setAppSettings: (patch: { anthropicApiKey?: string; geminiApiKey?: string }) => Promise<GentoResult<AppSettingsSummary>>;
      importStage4FinalScript: (
        recapPath: string,
        finalScriptJson: string,
      ) => Promise<GentoResult<{ refined_recap_path: string }>>;
      importStage4GeminiJson: (
        outPath: string,
        geminiJson: string,
      ) => Promise<GentoResult<{ gemini_path: string }>>;
      scrapeManga: (
        url: string,
        outDir?: string,
      ) => Promise<
        GentoResult<{
          manga_metadata: Record<string, unknown>;
          chapters: Array<{ name: string; url: string }>;
        }>
      >;
      openPath: (path: string) => Promise<GentoResult<{ path: string }>>;
      pathExists: (path: string) => Promise<GentoResult<{ path: string; exists: boolean }>>;
      onStageEvent: (callback: (payload: StageEvent) => void) => () => void;
    };
  }
}
