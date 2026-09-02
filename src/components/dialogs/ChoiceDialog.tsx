/**
 * App-wide multi-choice modal (in-WebView React, styled to match SLEAP), driven by
 * {@link useChoiceStore}. Rendered once near the app root; every `choiceDialog({ … })`
 * call surfaces here. Dismissing (Esc / click-outside / ✕) resolves `null` (Cancel).
 *
 * The 3+-option sibling of {@link import("@/components/dialogs/ConfirmDialog").ConfirmDialog}.
 */

import { useChoiceStore } from "@/stores/choiceStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function ChoiceDialog() {
  const request = useChoiceStore((s) => s.request);
  const respond = useChoiceStore((s) => s.respond);

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) respond(null); // Esc / outside / ✕ → Cancel
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title ?? "Choose an action"}</DialogTitle>
        </DialogHeader>
        {request && (
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground whitespace-pre-line text-sm">
              {request.message}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => respond(null)}
              >
                {request.cancelLabel ?? "Cancel"}
              </Button>
              {request.options.map((o) => (
                <Button
                  key={o.key}
                  variant={o.primary ? "default" : "secondary"}
                  size="sm"
                  onClick={() => respond(o.key)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
