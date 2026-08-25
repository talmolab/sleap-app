/**
 * Segmented control for switching between a pipeline's config slots (e.g. a
 * top-down model's Centroid and Centered Instance heads). Renders nothing for a
 * single-slot pipeline.
 */
export function SlotSwitcher({
  slots,
  active,
  onChange,
}: {
  slots: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  if (slots.length < 2) return null;
  return (
    <div className="inline-flex items-center rounded-md border border-input bg-background p-0.5">
      {slots.map((s) => (
        <button
          key={s.id}
          onClick={() => onChange(s.id)}
          className={`px-3 py-1 text-xs rounded transition-colors ${
            active === s.id
              ? "bg-primary/15 text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
