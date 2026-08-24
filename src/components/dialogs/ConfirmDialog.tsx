/**
 * App-wide confirm modal (in-WebView React, styled to match SLEAP), driven by
 * {@link useConfirmStore}. Rendered once near the app root; every
 * `confirmDialog({ … })` call surfaces here. Dismissing (Esc / click-outside /
 * ✕) counts as Cancel, matching native confirm semantics.
 *
 * Replaces `window.confirm` / native OS dialogs — see {@link confirmDialog} for
 * why (broken/inconsistent in the Tauri WebView).
 */

import { useConfirmStore } from "@/stores/confirmStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function ConfirmDialog() {
  const request = useConfirmStore((s) => s.request);
  const respond = useConfirmStore((s) => s.respond);

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) respond(false); // Esc / outside / ✕ → Cancel
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title ?? "Confirm"}</DialogTitle>
        </DialogHeader>
        {request && (
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground whitespace-pre-line text-sm">
              {request.message}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                data-confirm="cancel"
                onClick={() => respond(false)}
              >
                {request.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={request.destructive ? "destructive" : "default"}
                size="sm"
                data-confirm="ok"
                onClick={() => respond(true)}
              >
                {request.confirmLabel ?? "OK"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
