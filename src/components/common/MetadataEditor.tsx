/**
 * Reusable, collapsed-when-empty scalar key-value editor for SLP 3.0 record
 * metadata (`Instance`, `LabeledFrame`, `BoundingBox`).
 *
 * Supports `string | number | boolean` scalar values. Stops keydown propagation
 * inside inputs so canvas shortcuts never fire while editing. When any boolean
 * value is present (or being added), displays a subtle note matching
 * `sleap-io.js@0.6.0-alpha.0` serialization semantics (booleans write as uint8
 * with `kind="bool"`, which Python `sleap-io` reads back as `0`/`1`).
 */

import { useEffect, useState } from "react";
import { ChevronRight, Plus, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { RecordMetadata } from "@/lib/slpFormat";

type MetadataKind = "string" | "number" | "boolean";
type MetadataScalar = string | number | boolean;

function kindOf(v: MetadataScalar): MetadataKind {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  return "string";
}

function coerceValue(raw: MetadataScalar, nextKind: MetadataKind): MetadataScalar {
  if (nextKind === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number") return raw !== 0;
    const lower = raw.trim().toLowerCase();
    return lower === "true" || lower === "1" || lower === "yes";
  }
  if (nextKind === "number") {
    if (typeof raw === "number") return raw;
    if (typeof raw === "boolean") return raw ? 1 : 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return String(raw);
}

/** Compact `key=value` preview string for tooltips and table cells. */
export function formatMetadataPreview(
  metadata: RecordMetadata | null | undefined,
  maxEntries = 3,
): string {
  if (!metadata) return "";
  const entries = Object.entries(metadata);
  if (entries.length === 0) return "";
  const shown = entries.slice(0, maxEntries).map(([k, v]) => `${k}=${String(v)}`);
  if (entries.length > maxEntries) shown.push(`+${entries.length - maxEntries} more`);
  return shown.join(", ");
}

/** Single editable row for an existing metadata entry. */
function MetadataRow({
  fieldKey,
  value,
  readOnly,
  onUpdate,
  onRemove,
}: {
  fieldKey: string;
  value: MetadataScalar;
  readOnly: boolean;
  onUpdate: (next: MetadataScalar) => void;
  onRemove: () => void;
}) {
  const kind = kindOf(value);
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commitText = () => {
    if (kind === "number") {
      const trimmed = draft.trim();
      if (trimmed === "") {
        setDraft(String(value));
        return;
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        setDraft(String(value));
        return;
      }
      if (n !== value) onUpdate(n);
    } else if (draft !== value) {
      onUpdate(draft);
    }
  };

  return (
    <div className="flex items-center gap-1 text-[11px]">
      <span
        className="min-w-0 w-20 shrink-0 truncate font-mono text-foreground"
        title={fieldKey}
      >
        {fieldKey}
      </span>

      {readOnly ? (
        <>
          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
            {kind === "string" ? "str" : kind === "number" ? "num" : "bool"}
          </span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-muted-foreground select-text"
            title={String(value)}
          >
            {String(value)}
          </span>
        </>
      ) : (
        <>
          <select
            aria-label={`Type for ${fieldKey}`}
            value={kind}
            onChange={(e) => onUpdate(coerceValue(value, e.target.value as MetadataKind))}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="h-5 shrink-0 rounded border border-input bg-background px-1 text-[10px] text-muted-foreground"
          >
            <option value="string">str</option>
            <option value="number">num</option>
            <option value="boolean">bool</option>
          </select>

          {kind === "boolean" ? (
            <label
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 font-mono text-[11px]"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                aria-label={`Value for ${fieldKey}`}
                checked={Boolean(value)}
                onChange={(e) => onUpdate(e.target.checked)}
                onKeyDown={(e) => e.stopPropagation()}
                className="accent-primary h-3.5 w-3.5"
              />
              <span>{value ? "true" : "false"}</span>
            </label>
          ) : (
            <Input
              type={kind === "number" ? "number" : "text"}
              step={kind === "number" ? "any" : undefined}
              aria-label={`Value for ${fieldKey}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setDraft(String(value));
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-5 min-w-0 flex-1 px-1.5 font-mono text-[11px]"
            />
          )}

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove metadata ${fieldKey}`}
            title={`Remove "${fieldKey}"`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </Button>
        </>
      )}
    </div>
  );
}

export interface MetadataEditorProps {
  /** Heading label (default: "Metadata"). */
  label?: string;
  /** Current scalar metadata dictionary (empty/null collapses cleanly). */
  metadata: RecordMetadata | null | undefined;
  /** True when the project is View only or metadata editing is disabled. */
  readOnly?: boolean;
  /** Called with the complete updated metadata object (`{}` when cleared). */
  onChange: (next: RecordMetadata) => void;
  /** Optional `data-testid` root attribute. */
  testId?: string;
  className?: string;
}

export function MetadataEditor({
  label = "Metadata",
  metadata,
  readOnly = false,
  onChange,
  testId,
  className,
}: MetadataEditorProps) {
  const entries = metadata ? Object.entries(metadata) : [];
  const count = entries.length;
  const [open, setOpen] = useState(count > 0);
  const [newKey, setNewKey] = useState("");
  const [newKind, setNewKind] = useState<MetadataKind>("string");
  const [newValue, setNewValue] = useState("");
  const [newBool, setNewBool] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Auto-open when switching to a record that carries metadata; collapse when
  // switching to an empty one so empty records stay uncluttered.
  useEffect(() => {
    setOpen(count > 0);
    setError(null);
  }, [count]);

  const hasBoolean =
    entries.some(([, v]) => typeof v === "boolean") ||
    (open && !readOnly && newKind === "boolean");

  const handleUpdate = (key: string, nextVal: MetadataScalar) => {
    const next: RecordMetadata = { ...(metadata ?? {}), [key]: nextVal };
    onChange(next);
  };

  const handleRemove = (key: string) => {
    const next: RecordMetadata = { ...(metadata ?? {}) };
    delete next[key];
    onChange(next);
  };

  const handleAdd = () => {
    const trimmedKey = newKey.trim();
    if (!trimmedKey) {
      setError("Enter a key name.");
      return;
    }
    if (metadata && Object.hasOwn(metadata, trimmedKey)) {
      setError(`"${trimmedKey}" already exists.`);
      return;
    }
    let parsed: MetadataScalar;
    if (newKind === "boolean") {
      parsed = newBool;
    } else if (newKind === "number") {
      const trimmedVal = newValue.trim();
      if (trimmedVal === "") {
        setError("Enter a number.");
        return;
      }
      const n = Number(trimmedVal);
      if (!Number.isFinite(n)) {
        setError("Enter a valid number.");
        return;
      }
      parsed = n;
    } else {
      parsed = newValue;
    }
    setError(null);
    setNewKey("");
    setNewValue("");
    onChange({ ...(metadata ?? {}), [trimmedKey]: parsed });
  };

  return (
    <div
      data-testid={testId}
      className={cn("text-xs", className)}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight
            className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
          />
          <Tag className="h-3 w-3 shrink-0 opacity-70" />
          <span className="truncate">{label}</span>
          {count > 0 && (
            <span className="rounded bg-muted px-1 text-[10px] tabular-nums text-foreground">
              {count}
            </span>
          )}
        </button>

        {!open && !readOnly && count === 0 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-[10px] text-muted-foreground hover:text-foreground px-1 py-0.5"
          >
            + Add
          </button>
        )}
      </div>

      {open && (
        <div className="mt-1 space-y-1.5 rounded bg-muted/30 p-1.5">
          {count === 0 ? (
            <p className="text-[10px] text-muted-foreground">
              {readOnly ? "No metadata." : "No metadata yet."}
            </p>
          ) : (
            <div className="space-y-1">
              {entries.map(([k, v]) => (
                <MetadataRow
                  key={k}
                  fieldKey={k}
                  value={v}
                  readOnly={readOnly}
                  onUpdate={(next) => handleUpdate(k, next)}
                  onRemove={() => handleRemove(k)}
                />
              ))}
            </div>
          )}

          {!readOnly && (
            <div className="space-y-1 border-t border-border/50 pt-1.5">
              <div className="flex items-center gap-1">
                <Input
                  type="text"
                  placeholder="key"
                  aria-label={`New ${label.toLowerCase()} key`}
                  value={newKey}
                  onChange={(e) => {
                    setNewKey(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAdd();
                    if (e.key === "Escape") {
                      setNewKey("");
                      setNewValue("");
                      setError(null);
                    }
                    e.stopPropagation();
                  }}
                  className="h-5 w-20 shrink-0 px-1.5 font-mono text-[11px]"
                />

                <select
                  aria-label={`New ${label.toLowerCase()} type`}
                  value={newKind}
                  onChange={(e) => {
                    setNewKind(e.target.value as MetadataKind);
                    setError(null);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="h-5 shrink-0 rounded border border-input bg-background px-1 text-[10px] text-muted-foreground"
                >
                  <option value="string">str</option>
                  <option value="number">num</option>
                  <option value="boolean">bool</option>
                </select>

                {newKind === "boolean" ? (
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 font-mono text-[11px]">
                    <input
                      type="checkbox"
                      aria-label={`New ${label.toLowerCase()} value`}
                      checked={newBool}
                      onChange={(e) => setNewBool(e.target.checked)}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="accent-primary h-3.5 w-3.5"
                    />
                    <span>{newBool ? "true" : "false"}</span>
                  </label>
                ) : (
                  <Input
                    type={newKind === "number" ? "number" : "text"}
                    step={newKind === "number" ? "any" : undefined}
                    placeholder={newKind === "number" ? "0" : "value"}
                    aria-label={`New ${label.toLowerCase()} value`}
                    value={newValue}
                    onChange={(e) => {
                      setNewValue(e.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAdd();
                      if (e.key === "Escape") {
                        setNewValue("");
                        setError(null);
                      }
                      e.stopPropagation();
                    }}
                    className="h-5 min-w-0 flex-1 px-1.5 font-mono text-[11px]"
                  />
                )}

                <Button
                  type="button"
                  variant="subtle"
                  size="icon-xs"
                  aria-label={`Add ${label.toLowerCase()} field`}
                  title="Add field"
                  onClick={handleAdd}
                  className="h-5 w-5 shrink-0"
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
              {error && <p className="text-[10px] text-destructive">{error}</p>}
            </div>
          )}

          {hasBoolean && (
            <p
              data-testid="metadata-bool-note"
              className="text-[10px] leading-snug text-muted-foreground"
            >
              Boolean values save as <code>uint8</code> (<code>kind=&quot;bool&quot;</code>):{" "}
              <code>sleap-io.js</code> reads them as booleans, while Python{" "}
              <code>sleap-io</code> reads them as <code>0</code>/<code>1</code>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
