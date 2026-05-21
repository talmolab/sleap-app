import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface LogNumberInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  factor?: number;
  className?: string;
  disabled?: boolean;
}

export function LogNumberInput({
  value,
  onChange,
  min = 0.001,
  factor = 10,
  className,
  disabled,
}: LogNumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);
  const isSpinning = useRef(false);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(String(value));
    }
  }, [value]);

  const isValid = draft !== "" && !isNaN(Number(draft)) && Number(draft) > 0;

  const commit = () => {
    const v = Number(draft);
    if (!isNaN(v) && v > 0) {
      onChange(v);
      setDraft(String(v));
    } else {
      setDraft(String(value));
    }
  };

  const applyStep = (direction: "up" | "down") => {
    const next = direction === "up" ? value * factor : value / factor;
    const clamped = next >= min ? next : min;
    onChange(clamped);
    setDraft(String(clamped));
  };

  return (
    <Input
      ref={inputRef}
      type="number"
      value={draft}
      onChange={(e) => {
        // Native spinner buttons fire onChange — detect via the flag
        // set in onPointerDown on the spinner area, or via nativeEvent.
        const nativeEvent = e.nativeEvent as InputEvent;
        if (isSpinning.current || nativeEvent.inputType === undefined) {
          // Spinner click: determine direction from native value change
          const nativeVal = Number(e.target.value);
          const direction = nativeVal > value ? "up" : "down";
          isSpinning.current = false;
          applyStep(direction);
          return;
        }
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          inputRef.current?.blur();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          applyStep("up");
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          applyStep("down");
        }
      }}
      step="any"
      className={cn(
        className,
        !isValid && "border-red-500 focus-visible:border-red-500 focus-visible:ring-red-500/50"
      )}
      disabled={disabled}
    />
  );
}
