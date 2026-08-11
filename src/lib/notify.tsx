import { toast as sonnerToast, type ExternalToast } from "sonner";
import { pushNotification } from "./notificationStore";
import { useState } from "react";
import { Copy, Check } from "lucide-react";

type TitleT = (() => React.ReactNode) | React.ReactNode;

/** Extract plain text from toast message + description. */
function extractText(message: TitleT, description?: unknown): string {
  const msg = typeof message === "string" ? message : "";
  const desc = typeof description === "string" ? description : "";
  return desc ? `${msg}\n${desc}` : msg;
}

/** Small copy button shown on toast hover via CSS. */
function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      data-copy-btn=""
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="absolute top-2 right-2 p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-all"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-400" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function wrapMethod(
  method: "success" | "error" | "info" | "warning",
  fn: (message: TitleT, data?: ExternalToast) => string | number,
) {
  return (message: TitleT, data?: ExternalToast) => {
    const text = extractText(message, data?.description);
    pushNotification(
      method,
      typeof message === "string" ? message : String(message),
      typeof data?.description === "string" ? data.description : undefined,
    );
    return fn(message, {
      ...data,
      action: data?.action ?? <CopyAction text={text} />,
    });
  };
}

/** Drop-in replacement for Sonner's `toast` that logs to the notification store. */
export const toast: typeof sonnerToast = Object.assign(
  (message: TitleT, data?: ExternalToast) => {
    const text = extractText(message, data?.description);
    pushNotification(
      "info",
      typeof message === "string" ? message : String(message),
      typeof data?.description === "string" ? data.description : undefined,
    );
    return sonnerToast(message, {
      ...data,
      action: data?.action ?? <CopyAction text={text} />,
    });
  },
  {
    success: wrapMethod("success", sonnerToast.success),
    error: wrapMethod("error", sonnerToast.error),
    info: wrapMethod("info", sonnerToast.info),
    warning: wrapMethod("warning", sonnerToast.warning),
    // Pass through methods that don't need interception
    message: sonnerToast.message,
    loading: sonnerToast.loading,
    promise: sonnerToast.promise,
    dismiss: sonnerToast.dismiss,
    custom: sonnerToast.custom,
    getHistory: sonnerToast.getHistory,
    getToasts: sonnerToast.getToasts,
  },
) as typeof sonnerToast;

/**
 * Dismiss toasts. Called with a toast id it dismisses that toast; called with
 * NO argument it dismisses ALL currently-stacked live on-screen toasts (this is
 * sonner v2's built-in dismiss-all behaviour). This is the live-stack analogue
 * of the NotificationsPanel "Clear" button, which only empties the persistent
 * history buffer.
 */
export const dismiss = sonnerToast.dismiss;
