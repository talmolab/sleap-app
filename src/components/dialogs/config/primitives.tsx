import { useState } from "react";
import { createPortal } from "react-dom";
import { HelpCircle } from "lucide-react";

/** Hover help bubble, portaled to <body> so it escapes the scroll container. */
export function HintBubble({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span className="relative">
      <HelpCircle
        className="h-3.5 w-3.5 text-muted-foreground/50 hover:text-muted-foreground cursor-help"
        onMouseEnter={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPos({ x: rect.left + rect.width / 2, y: rect.top });
        }}
        onMouseLeave={() => setPos(null)}
      />
      {pos &&
        createPortal(
          <span
            className="fixed z-[9999] px-3 py-2 text-xs bg-popover border rounded-md shadow-lg w-64 text-foreground leading-relaxed"
            style={{ left: pos.x, top: pos.y - 8, transform: "translate(-50%, -100%)" }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** Stable anchor for a field, derived from its label (for search jump/highlight). */
export function fieldSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Label + optional hint on the left, control on the right. */
export function Field({
  label,
  id,
  hint,
  children,
}: {
  label: string;
  id?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} data-field={fieldSlug(label)} data-search-field={id ? "" : undefined} className="flex items-center gap-6 py-2.5 scroll-mt-4 rounded-md">
      <span className="text-sm text-muted-foreground shrink-0 flex items-center gap-1.5">
        {label}
        {hint && <HintBubble text={hint} />}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

/** A boolean toggle row, styled to match Field. */
export function Toggle({
  label,
  id,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  id?: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      id={id}
      data-field={fieldSlug(label)}
      data-search-field={id ? "" : undefined}
      className={`flex items-center gap-6 py-2.5 scroll-mt-4 rounded-md ${disabled ? "opacity-50" : ""}`}
    >
      <span className="text-sm text-muted-foreground shrink-0 flex items-center gap-1.5">
        {label}
        {hint && <HintBubble text={hint} />}
      </span>
      <button
        disabled={disabled}
        className={`w-10 h-6 rounded-full relative transition-colors ${checked ? "bg-primary" : "bg-zinc-700"} ${disabled ? "cursor-not-allowed" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`}
        />
      </button>
    </div>
  );
}
