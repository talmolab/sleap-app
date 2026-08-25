import { useState } from "react";
import { Check, RotateCcw } from "lucide-react";
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
 * pane. Auto-save is live (edits flow straight through onUpdate), so the header
 * says so plainly; the footer offers reset-to-defaults. Rendered inside either a
 * modal or a docked panel.
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
}: {
  title: string;
  sections: ShellSection[];
  hp: ConfigHyperparams;
  onUpdate: (updates: Partial<ConfigHyperparams>) => void;
  onResetAll: () => void;
  initialSectionId?: string;
  slot?: string;
  modelType?: string;
}) {
  const [activeId, setActiveId] = useState(initialSectionId ?? sections[0]?.id ?? "");
  const [query, setQuery] = useState("");

  const visible = query.trim()
    ? sections.filter((s) => s.label.toLowerCase().includes(query.trim().toLowerCase()))
    : sections;
  const active = sections.find((s) => s.id === activeId) ?? sections[0];

  return (
    <div className="flex flex-col h-full bg-muted/20 text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b shrink-0">
        <h2 className="text-base font-semibold">{title}</h2>
        <span
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          title="Edits are saved automatically as you type"
        >
          <Check className="h-3.5 w-3.5 text-emerald-400" />
          All changes saved
        </span>
      </div>

      {/* Body: rail + field pane */}
      <div className="flex flex-1 min-h-0">
        <nav className="w-56 shrink-0 border-r flex flex-col">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fields…"
            className="m-3 h-8 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus:border-primary/60"
          />
          <div className="flex-1 overflow-y-auto pb-2">
            {visible.map((s) => {
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
          </div>
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
      <div className="flex items-center px-6 py-3 border-t shrink-0">
        <button
          onClick={onResetAll}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset to profile defaults…
        </button>
      </div>
    </div>
  );
}
