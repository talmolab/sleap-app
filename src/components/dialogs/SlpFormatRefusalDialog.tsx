/**
 * Modal shown when `@talmolab/sleap-io.js` refuses an `.slp` file whose format
 * or required features this version of SLEAP cannot read (e.g., SLP format 3.0).
 *
 * Mounted once near the app root ({@link AppShell}). Offers `[Cancel]` (leaves
 * the current project untouched) and `[Upgrade]` (opens the Environment panel
 * on desktop so the user can check for updates or switch update channels, or
 * opens the GitHub Releases page in a new tab on the web).
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  canSaveLegacyV2Copy,
  formatSlpVersion,
  legacyV2CopyCommand,
  SLEAP_APP_RELEASES_PAGE_URL,
  type SlpFormatRefusal,
} from "@/lib/slpFormatRefusal";
import { isTauri } from "@/platform/index";
import { useAppStore } from "@/stores/appStore";
import { useSlpFormatDialogStore } from "@/stores/slpFormatDialogStore";

/** Action invoked by the modal's `[Upgrade]` button (exported for unit tests). */
export function runSlpFormatUpgradeAction(): void {
  const dialogStore = useSlpFormatDialogStore.getState();
  dialogStore.close();

  if (isTauri) {
    const app = useAppStore.getState();
    if (app.mergeProjectDialogOpen) {
      app.setMergeProjectDialogOpen(false);
    }
    if (app.projectLoaded) {
      if (app.hiddenPanels.includes("environment")) {
        app.set(
          "hiddenPanels",
          app.hiddenPanels.filter((id) => id !== "environment"),
        );
      }
      app.openPanel("environment");
    } else {
      dialogStore.requestWelcomeEnvironment();
    }
    return;
  }

  window.open(SLEAP_APP_RELEASES_PAGE_URL, "_blank", "noopener,noreferrer");
}

function CopyableSnippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded bg-muted/60 p-2 pr-9 font-mono text-[11px] leading-snug select-text">
        {text}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-1 right-1 h-6 w-6"
        title="Copy Python snippet"
        aria-label="Copy Python snippet"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? (
          <Check className="h-3 w-3" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </Button>
    </div>
  );
}

function RefusalSummary({ refusal }: { refusal: SlpFormatRefusal }) {
  const versionLabel =
    refusal.formatId !== null ? formatSlpVersion(refusal.formatId) : null;

  if (refusal.unsupportedFeatures.length > 0) {
    return (
      <p>
        <span className="font-medium text-foreground">{refusal.fileName}</span>
        {versionLabel ? ` (SLP format ${versionLabel})` : ""} requires features
        not supported in this version of SLEAP (
        {refusal.unsupportedFeatures.join(", ")}). Upgrade SLEAP to open this
        file.
      </p>
    );
  }

  if (versionLabel !== null) {
    return (
      <p>
        <span className="font-medium text-foreground">{refusal.fileName}</span>{" "}
        was saved with{" "}
        <span className="font-medium text-foreground">
          SLP format {versionLabel}
        </span>
        , which cannot be opened in this version of SLEAP. Upgrade SLEAP to open
        this file.
      </p>
    );
  }

  return (
    <p>
      <span className="font-medium text-foreground">{refusal.fileName}</span>{" "}
      uses an SLP format that cannot be opened in this version of SLEAP. Upgrade
      SLEAP to open this file.
    </p>
  );
}

export function SlpFormatRefusalDialog() {
  const refusal = useSlpFormatDialogStore((s) => s.refusal);
  const close = useSlpFormatDialogStore((s) => s.close);

  return (
    <Dialog
      open={refusal !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        data-testid="slp-format-refusal-dialog"
      >
        {refusal && (
          <>
            <DialogHeader>
              <DialogTitle>Unsupported SLP format</DialogTitle>
              <DialogDescription className="sr-only">
                This file uses an SLP format that requires upgrading SLEAP.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3 text-sm text-muted-foreground">
              <RefusalSummary refusal={refusal} />

              {canSaveLegacyV2Copy(refusal.formatId) && (
                <div className="space-y-1.5">
                  <p>
                    Or re-save a 2.x copy in Python (<code>sleap-io &gt;= 0.10</code>
                    ):
                  </p>
                  <CopyableSnippet
                    text={legacyV2CopyCommand(refusal.fileName)}
                  />
                </div>
              )}

              {refusal.detail && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">
                    Technical details
                  </summary>
                  <p className="mt-1 whitespace-pre-line break-words select-text">
                    {refusal.detail}
                  </p>
                </details>
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="slp-format-refusal-cancel"
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="slp-format-refusal-upgrade"
                onClick={runSlpFormatUpgradeAction}
              >
                Upgrade
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
