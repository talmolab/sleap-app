/**
 * App-wide text-input prompt modal (in-WebView React, styled to match SLEAP),
 * driven by {@link usePromptStore}. Rendered once near the app root; every
 * `promptDialog({ … })` call surfaces here. Dismissing (Esc / click-outside /
 * ✕) counts as Cancel (resolves null), matching native prompt semantics.
 *
 * Replaces `window.prompt`, which is not implemented in the Tauri WebView.
 */

import { useEffect, useRef, useState } from "react";
import { usePromptStore } from "@/stores/promptStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PromptDialog() {
  const request = usePromptStore((s) => s.request);
  const respond = usePromptStore((s) => s.respond);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus the field whenever a new prompt opens.
  useEffect(() => {
    if (!request) return;
    setValue(request.defaultValue ?? "");
    queueMicrotask(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [request]);

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) respond(null); // Esc / outside / ✕ → Cancel
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title ?? "Enter a value"}</DialogTitle>
        </DialogHeader>
        {request && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              respond(value);
            }}
          >
            <label className="text-muted-foreground whitespace-pre-line text-sm">
              {request.message}
            </label>
            <Input
              ref={inputRef}
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-prompt="cancel"
                onClick={() => respond(null)}
              >
                {request.cancelLabel ?? "Cancel"}
              </Button>
              <Button type="submit" size="sm" data-prompt="ok">
                {request.confirmLabel ?? "OK"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
