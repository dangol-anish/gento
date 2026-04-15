import { Button } from "@/components/ui/button";
import { type Chapter } from "@/lib/stage0";

type Props = {
  chapters: Chapter[];
  selectedChapterUrls: Set<string>;
  allSelected: boolean;
  rangeStart: string;
  rangeEnd: string;
  setRangeStart: (value: string) => void;
  setRangeEnd: (value: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onApplyRange: () => void;
  onToggleChapter: (url: string) => void;
};

export function ChapterPicker({
  chapters,
  selectedChapterUrls,
  allSelected,
  rangeStart,
  rangeEnd,
  setRangeStart,
  setRangeEnd,
  onSelectAll,
  onClear,
  onApplyRange,
  onToggleChapter,
}: Props) {
  return (
    <div className="glass-surface space-y-2.5 rounded-xl p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSelectAll}
          className={`h-8 rounded-lg px-2.5 text-xs transition-colors ${
            allSelected
              ? "glass-interactive text-foreground"
              : "glass-surface text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          }`}
        >
          Select All
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={selectedChapterUrls.size === 0}
          className={`h-8 rounded-lg px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            selectedChapterUrls.size === 0
              ? "glass-surface text-muted-foreground"
              : "glass-surface text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          }`}
        >
          Clear
        </button>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Range</span>
          <input
            value={rangeStart}
            onChange={(event) => setRangeStart(event.target.value)}
            className="glass-interactive h-7 w-12 rounded-md px-1.5 text-center text-xs text-foreground outline-none"
          />
          <span>-</span>
          <input
            value={rangeEnd}
            onChange={(event) => setRangeEnd(event.target.value)}
            className="glass-interactive h-7 w-12 rounded-md px-1.5 text-center text-xs text-foreground outline-none"
          />
          <Button variant="secondary" size="sm" className="h-7 rounded-md px-2 text-xs" onClick={onApplyRange}>
            Apply
          </Button>
        </div>
      </div>

      <div className="no-scrollbar max-h-48 overflow-y-auto rounded-xl">
        {chapters.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Scrape manga to load chapter list.</p>
        ) : (
          <div className="space-y-1">
            {chapters.map((chapter) => (
              <button
                key={chapter.url}
                type="button"
                onClick={() => onToggleChapter(chapter.url)}
                className={`flex w-full items-center justify-between rounded-lg border border-transparent px-2 py-1.5 text-left text-sm ${
                  selectedChapterUrls.has(chapter.url)
                    ? "glass-interactive text-foreground"
                    : "text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                }`}
              >
                <span className="truncate pr-2">{chapter.name}</span>
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    selectedChapterUrls.has(chapter.url) ? "bg-primary" : "bg-muted-foreground/45"
                  }`}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

