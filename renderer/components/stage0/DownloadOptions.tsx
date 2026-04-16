type Props = {
  downloadFormat: "none" | "pdf" | "cbz";
  setDownloadFormat: (format: "none" | "pdf" | "cbz") => void;
  deleteImages: boolean;
  setDeleteImages: (value: boolean) => void;
};

export function DownloadOptions({
  downloadFormat,
  setDownloadFormat,
  deleteImages,
  setDeleteImages,
}: Props) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex gap-2 justify-center items-center">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Format
        </label>
        <button
          type="button"
          onClick={() => setDownloadFormat("none")}
          className={`h-7 rounded-md px-2.5 text-xs transition-colors ${
            downloadFormat === "none"
              ? "glass-interactive text-foreground"
              : "glass-surface text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          }`}
        >
          Images
        </button>
        <button
          type="button"
          onClick={() => setDownloadFormat("pdf")}
          className={`h-7 rounded-md px-2.5 text-xs transition-colors ${
            downloadFormat === "pdf"
              ? "glass-interactive text-foreground"
              : "glass-surface text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          }`}
        >
          PDF
        </button>
        <button
          type="button"
          onClick={() => setDownloadFormat("cbz")}
          className={`h-7 rounded-md px-2.5 text-xs transition-colors ${
            downloadFormat === "cbz"
              ? "glass-interactive text-foreground"
              : "glass-surface text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          }`}
        >
          CBZ
        </button>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={deleteImages}
          onChange={(event) => setDeleteImages(event.target.checked)}
          disabled={downloadFormat === "none"}
          className="h-4 w-4 accent-black"
        />
        Delete images after conversion
      </label>
    </div>
  );
}
