export {};

type GentoError = {
  code: string;
  message: string;
  details?: unknown;
};

type GentoSuccess<T> = { ok: true; data: T; error: null };
type GentoFailure = { ok: false; data: null; error: GentoError };
type GentoResult<T> = GentoSuccess<T> | GentoFailure;

type StageEvent = {
  type: "progress" | "complete" | "error" | "log";
  stage?: number;
  percent?: number;
  message?: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  chapters?: Array<{ name: string; url: string }>;
  manga_metadata?: Record<string, unknown>;
  output_dir?: string;
  downloaded_chapters?: number;
  storyboard_path?: string;
};

declare global {
  interface Window {
    gento: {
      runStage: (stage: number, args?: string[]) => Promise<GentoResult<{ events: StageEvent[] }>>;
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
      onStageEvent: (callback: (payload: StageEvent) => void) => () => void;
    };
  }
}
