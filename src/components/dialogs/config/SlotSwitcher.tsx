/**
 * Segmented control for switching between config tabs (Pipeline + one per head
 * slot, e.g. Centroid / Centered Instance). Renders nothing for a single tab.
 */
export function SlotSwitcher({
  slots,
  active,
  onChange,
  size = "sm",
}: {
  slots: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
  size?: "sm" | "lg";
}) {
  if (slots.length < 2) return null;
  const btn = size === "lg" ? "px-4 py-1 text-base" : "px-3 py-1 text-xs";
  return (
    <div className="inline-flex items-center rounded-lg border border-input bg-background p-0.5">
      {slots.map((s) => (
        <button
          key={s.id}
          onClick={() => onChange(s.id)}
          className={`${btn} rounded-md transition-colors ${
            active === s.id
              ? "bg-primary/15 text-foreground font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
