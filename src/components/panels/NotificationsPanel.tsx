import { useEffect, useRef, useState } from "react";
import { CheckCircle2, XCircle, Info, AlertTriangle, Clipboard, ClipboardCopy } from "lucide-react";
import {
  notificationBuffer,
  notificationListeners,
  clearNotifications,
  type NotificationEntry,
} from "../../lib/notificationStore";

const TYPE_COLORS: Record<NotificationEntry["type"], string> = {
  success: "text-green-400",
  error: "text-red-400",
  info: "text-blue-400",
  warning: "text-yellow-400",
};

const TYPE_ICONS: Record<NotificationEntry["type"], typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
};

function entryText(entry: NotificationEntry): string {
  return entry.description
    ? `${entry.message}\n${entry.description}`
    : entry.message;
}

export function NotificationsPanel() {
  const [, setTick] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    notificationListeners.add(listener);
    return () => {
      notificationListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (autoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  });

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    autoScroll.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const clear = () => {
    clearNotifications();
    setTick((t) => t + 1);
  };

  return (
    <div className="flex flex-col h-full -m-2">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
        <button
          onClick={clear}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Clear
        </button>
        <button
          onClick={() => {
            const text = notificationBuffer.map((e) => {
              const ts = new Date(e.timestamp).toLocaleTimeString([], {
                hour12: false,
                fractionalSecondDigits: 3,
              } as Intl.DateTimeFormatOptions);
              return `[${ts}] [${e.type}] ${entryText(e)}`;
            }).join("\n");
            navigator.clipboard.writeText(text);
          }}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          title="Copy all notifications"
        >
          <ClipboardCopy className="h-3 w-3" />
          Copy All
        </button>
        <span className="text-xs text-muted-foreground ml-auto">
          {notificationBuffer.length} entries
        </span>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto text-[11px] leading-[18px] p-1 min-h-0"
      >
        {notificationBuffer.map((entry) => {
          const time = new Date(entry.timestamp);
          const ts = time.toLocaleTimeString([], {
            hour12: false,
            fractionalSecondDigits: 3,
          } as Intl.DateTimeFormatOptions);
          const Icon = TYPE_ICONS[entry.type];

          return (
            <div
              key={entry.id}
              className={`group flex gap-1.5 px-1 py-0.5 hover:bg-accent/30 ${TYPE_COLORS[entry.type]}`}
            >
              <span className="text-muted-foreground shrink-0 select-none">
                {ts}
              </span>
              <Icon className="h-3 w-3 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <span>{entry.message}</span>
                {entry.description && (
                  <span className="text-muted-foreground block text-[10px]">
                    {entry.description}
                  </span>
                )}
              </div>
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-0.5 hover:text-foreground"
                onClick={() => navigator.clipboard.writeText(entryText(entry))}
                title="Copy"
              >
                <Clipboard className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
