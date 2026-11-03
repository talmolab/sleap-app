import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A number field that behaves like SLEAP's Qt spin boxes.
 *
 * - While focused you can clear it and type freely ("", "-", "0.", "01"): the
 *   text is a local draft, never forced back to a number mid-edit.
 * - Each keystroke that leaves a valid, in-range number commits it right away
 *   (so live previews follow along).
 * - On blur or Enter, the draft is settled: empty or unparseable text reverts
 *   to the last committed value (or, with `nullable`, empty commits `null`),
 *   out-of-range text is clamped to `[min, max]`, and `integer` rounds.
 *   Escape reverts.
 * - The box is outlined red while its text wouldn't commit as-is.
 *
 * So an invalid value never reaches the caller, and nothing downstream needs
 * to guard against one.
 */
type BaseProps = Omit<
  ComponentProps<typeof Input>,
  "type" | "value" | "defaultValue" | "onChange" | "min" | "max" | "step"
> & {
  min?: number;
  max?: number;
  step?: number | "any";
  /** Only whole numbers (rounded on commit). */
  integer?: boolean;
};

type NumberInputProps = BaseProps &
  (
    | { nullable?: false; value: number | null | undefined; onCommit: (value: number) => void }
    | {
        /** Empty is a valid value: committed as `null` (e.g. "Auto" / "None"). */
        nullable: true;
        value: number | null | undefined;
        onCommit: (value: number | null) => void;
      }
  );

const toText = (value: number | null | undefined) =>
  value === null || value === undefined || Number.isNaN(value) ? "" : String(value);

export function NumberInput(props: NumberInputProps) {
  const {
    value,
    onCommit,
    nullable,
    min,
    max,
    step,
    integer,
    className,
    onBlur,
    onFocus,
    onKeyDown,
    ...rest
  } = props;
  const commit = onCommit as (value: number | null) => void;
  const [draft, setDraft] = useState(toText(value));
  const focused = useRef(false);
  // Set by Escape: the blur it triggers reverts instead of settling the draft.
  const reverting = useRef(false);

  // Follow outside changes, but never overwrite what the user is typing.
  useEffect(() => {
    if (!focused.current) setDraft(toText(value));
  }, [value]);

  /** `text` as a committable number, or null if it isn't one as-is. */
  const parse = (text: string): number | null => {
    if (text.trim() === "") return null;
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    if (integer && !Number.isInteger(n)) return null;
    if (min !== undefined && n < min) return null;
    if (max !== undefined && n > max) return null;
    return n;
  };

  const settle = () => {
    if (draft.trim() === "") {
      if (nullable) {
        commit(null);
        setDraft("");
      } else {
        setDraft(toText(value));
      }
      return;
    }
    let n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(toText(value));
      return;
    }
    if (integer) n = Math.round(n);
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    if (n !== value) commit(n);
    setDraft(String(n));
  };

  const invalid = draft.trim() === "" ? !nullable : parse(draft) === null;

  return (
    <Input
      {...rest}
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      value={draft}
      min={min}
      max={max}
      step={step ?? (integer ? 1 : "any")}
      aria-invalid={invalid || undefined}
      className={cn(invalid && "border-red-500 focus-visible:ring-red-500/40", className)}
      onFocus={(e) => {
        focused.current = true;
        onFocus?.(e);
      }}
      onChange={(e) => {
        // A number input reports "" for text it can't parse yet ("-", "1e");
        // keep the draft as typed and wait for the blur to settle it.
        const text = e.target.value;
        setDraft(text);
        const n = parse(text);
        if (n !== null && n !== value) commit(n);
      }}
      onBlur={(e) => {
        focused.current = false;
        if (reverting.current) {
          reverting.current = false;
          setDraft(toText(value));
        } else {
          settle();
        }
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          reverting.current = true;
          e.currentTarget.blur();
        }
        onKeyDown?.(e);
      }}
    />
  );
}
