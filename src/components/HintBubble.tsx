import { useState } from "react";
import { createPortal } from "react-dom";
import { HelpCircle } from "lucide-react";

/** A small "?" icon that shows a floating tooltip on hover, portaled to `document.body`. */
export function HintBubble({ text, className = "h-3.5 w-3.5" }: { text: string; className?: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span className="relative">
      <HelpCircle
        className={`text-muted-foreground/50 hover:text-muted-foreground cursor-help ${className}`}
        onMouseEnter={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPos({ x: rect.left + rect.width / 2, y: rect.top });
        }}
        onMouseLeave={() => setPos(null)}
      />
      {pos && createPortal(
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
