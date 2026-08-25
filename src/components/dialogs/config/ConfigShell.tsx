import { useMemo, useState } from "react";
import { Check, RotateCcw, Search } from "lucide-react";
import { matchConfigSearch, type SearchEntry } from "@/lib/configSearch";
import type { ConfigSection } from "@/lib/configSections";
import type { ConfigHyperparams } from "@/stores/trainingStore";

/** Context handed to each section's render function. */
export interface SectionRenderCtx {
  hp: ConfigHyperparams;
  onUpdate: (updates: Partial<ConfigHyperparams>) => void;
  /** The config slot (e.g. "centroid") — for slot-conditional fields like crop size. */
  slot?: string;
  /** The model type (e.g. "top_down") — for model-type-conditional fields. */
  modelType?: string;
}

/** A taxonomy section plus its (optional) field renderer. */
export interface ShellSection extends ConfigSection {
  render?: (ctx: SectionRenderCtx) => React.ReactNode;
}

/**
 * Host-agnostic two-pane config surface: a left section rail and a right field
 * pane, with a field-search row beneath the header. Auto-save is live (edits
 * flow straight through onUpdate), so the header says so plainly; the footer
 * offers reset-to-defaults. Rendered inside either a modal or a docked panel.
 */
export function ConfigShell({
  title,
  sections,
  hp,
  onUpdate,
  onResetAll,
  initialSectionId,
  slot,
  modelType,
  headerAccessory,
  onDone,
  searchIndex,
}: {
  title: string;
  sections: ShellSection[];
  hp: ConfigHyperparams;
  onUpdate: (updates: Partial<ConfigHyperparams>) => void;
  onResetAll: () => void;
  initialSectionId?: string;
  slot?: string;
  modelType?: string;
  /** Optional control shown in the header next to the title (e.g. a slot switcher). */
  headerAccessory?: React.ReactNode;
  /** When provided (modal host), renders a "Done" button in the footer. */
  onDone?: () => void;
  /** Field search index; when provided, the search row is shown. */
  searchIndex?: SearchEntry[];
}) {
  const [activeId, setActiveId] = useState(initialSectionId ?? sections[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);

  const sectionLabel = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of sections) m[s.id] = s.label;
    return m;
  }, [sections]);

  const results = useMemo(
    () => (searchIndex && query.trim() ? matchConfigSearch(query, searchIndex) : []),
    [searchIndex, query],
  );

  const active = sections.find((s) => s.id === activeId) ?? sections[0];

  function goToResult(sectionId: string) {
    setActiveId(sectionId);
    setQuery("");
    setSearchFocused(false);
  }

  return (
    <div className="flex flex-col h-full bg-muted/20 text-foreground">
      {/* Header: title + accessory (slot switcher) + saved indicator */}
      <div className="flex items-center justify-between gap-4 pl-6 pr-12 py-3 border-b shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <h2 className="text-base font-semibold shrink-0">{title}</h2>
          {headerAccessory}
        </div>
        <span
          className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0"
          title="Edits are saved automatically as you type"
        >
          <Check className="h-3.5 w-3.5 text-emerald-400" />
          All changes saved
        </span>
      </div>

      {/* Field search row (full width, below the header) */}
      {searchIndex && (
        <div className="relative border-b shrink-0 px-6 py-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 120)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && results[0]) goToResult(results[0].sectionId);
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search fields…"
              className="w-full h-8 rounded-md border border-input bg-background pl-8 pr-2.5 text-sm outline-none focus:border-primary/60"
            />
          </div>
          {searchFocused && query.trim() && (
            <ul className="absolute left-6 right-6 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border bg-popover shadow-lg py-1">
              {results.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted-foreground">No matching fields</li>
              ) : (
                results.map((r, i) => (
                  <li key={`${r.sectionId}-${r.label}-${i}`}>
                    <button
                      onMouseDown={(e) => { e.preventDefault(); goToResult(r.sectionId); }}
                      className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-muted/60"
                    >
                      <span className="truncate">{r.label}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{sectionLabel[r.sectionId] ?? r.sectionId}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}

      {/* Body: rail + field pane */}
      <div className="flex flex-1 min-h-0">
        <nav className="w-56 shrink-0 border-r overflow-y-auto py-2">
          {sections.map((s) => {
            const isActive = active?.id === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setActiveId(s.id)}
                className={`w-full flex items-center px-4 py-2 text-sm text-left transition-colors ${
                  isActive
                    ? "bg-primary/10 text-foreground border-l-2 border-primary"
                    : "text-muted-foreground hover:bg-muted/50 border-l-2 border-transparent"
                }`}
              >
                <span className="truncate">{s.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex-1 min-w-0 overflow-y-auto px-8 py-6">
          <h3 className="text-base font-medium pb-3">{active?.label}</h3>
          {active?.render ? (
            active.render({ hp, onUpdate, slot, modelType })
          ) : (
            <p className="text-sm text-muted-foreground py-8">
              This section isn’t wired up in the new layout yet.
            </p>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-3 border-t shrink-0">
        <button
          onClick={onResetAll}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset to profile defaults…
        </button>
        {onDone && (
          <button
            onClick={onDone}
            className="px-4 h-8 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}
