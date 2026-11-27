/**
 * Dialogs about SLP file formats, driven by {@link useSlpFormatStore}:
 * a file this version cannot read, the open-time choice for an SLP format 3.0
 * file (View only or Edit), merging such a file, and allowing edits of a
 * project opened View only. Rendered once near the app root.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useSlpFormatStore, type SlpFormatPrompt } from "@/stores/slpFormatStore";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  allowEditText,
  canSaveLegacyCopy,
  describeFormat3KeepDrops,
  formatLabel,
  legacyCopyCommand,
  refusalReason,
  SLEAP_APP_RELEASES_PAGE_URL,
} from "@/lib/slpAccess";
import { describeFormat3Features } from "@/lib/slpFormatStatus";
import { isTauri } from "@/platform/index";
import { useAppStore } from "@/stores/appStore";
import type { Format3Summary } from "@talmolab/sleap-io.js";

/** Action invoked by the refusal modal's `[Upgrade]` button (exported for unit tests). */
export function runSlpFormatUpgradeAction(): void {
  const formatStore = useSlpFormatStore.getState();
  formatStore.respond("ok");

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
      formatStore.requestWelcomeEnvironment();
    }
    return;
  }

  window.open(SLEAP_APP_RELEASES_PAGE_URL, "_blank", "noopener,noreferrer");
}

/** What saving natively in format 3.0 drops (unread tables), as a list. */
function DropList({ summary }: { summary: Format3Summary }) {
  const drops = describeFormat3KeepDrops(summary);
  if (drops.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Saving writes SLP format {formatLabel(summary.formatId)} and preserves
        all supported format 3.0 features in this file.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">
        Saving writes SLP format {formatLabel(summary.formatId)} (preserving
        unlabeled nodes and metadata), but drops:
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-sm" data-testid="slp-format-drops">
        {drops.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
    </div>
  );
}

function CopyableCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded bg-muted/60 p-2 pr-9 font-mono text-[11px] leading-snug select-text">
        {text}
      </pre>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-1 right-1 h-6 w-6"
        title="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

function RefusedBody({ prompt }: { prompt: Extract<SlpFormatPrompt, { kind: "refused" }> }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        <span className="font-medium">{prompt.fileName}</span> is a SLEAP labels
        file
        {prompt.formatId !== null ? ` in SLP format ${formatLabel(prompt.formatId)}` : ""}.{" "}
        {refusalReason(prompt.formatId, prompt.unsupportedFeatures, prompt.damagedTables)}
      </p>
      {canSaveLegacyCopy(prompt.formatId) && !prompt.damagedTables && (
        <div className="space-y-1.5">
          <p className="text-muted-foreground">
            To get a copy this app can open, save it in the 2.x layout with
            Python sleap-io 0.10 or newer. Nodes marked as not labeled are saved
            as hidden nodes with no position.
          </p>
          <CopyableCode text={legacyCopyCommand(prompt.fileName)} />
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">Details</summary>
        <p className="mt-1 whitespace-pre-line break-words select-text">{prompt.detail}</p>
      </details>
    </div>
  );
}

function title(prompt: SlpFormatPrompt): string {
  switch (prompt.kind) {
    case "refused":
      return "This file can't be opened";
    case "open":
      return `Open SLP format ${formatLabel(prompt.summary.formatId)} file`;
    case "merge":
      return `Merge SLP format ${formatLabel(prompt.summary.formatId)} file`;
    case "allow-edit":
      return prompt.action ? "This file is open View only" : "Allow editing?";
    case "upgrade-on-save":
      return `Upgrade ${prompt.fileName} to SLP 3.0?`;
  }
}

function UpgradeOnSaveBody({ summary }: { summary: Format3Summary }) {
  const features = describeFormat3Features(summary);
  return (
    <div className="flex flex-col gap-3 text-sm">
      {features.length > 0 && (
        <div className="space-y-1">
          <p className="text-muted-foreground">
            This project now includes SLP 3.0 features that the 2.x layout cannot store:
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm" data-testid="slp-upgrade-features">
            {features.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-muted-foreground">
        Saving as <span className="font-medium text-foreground">SLP 3.0</span> preserves all data,
        but requires <span className="font-medium text-foreground">SLEAP 0.2+</span> or{" "}
        <span className="font-medium text-foreground">sleap-io &gt;= 0.10</span>. Earlier versions
        of SLEAP (1.x) cannot open SLP 3.0 files.
      </p>
    </div>
  );
}

export function SlpFormatDialog() {
  const prompt = useSlpFormatStore((s) => s.prompt);
  const respond = useSlpFormatStore((s) => s.respond);

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) respond(prompt?.kind === "refused" ? "ok" : null);
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="slp-format-dialog">
        {prompt && (
          <>
            <DialogHeader>
              <DialogTitle>{title(prompt)}</DialogTitle>
              {prompt.kind === "refused" ? (
                <DialogDescription className="sr-only">
                  This file uses an SLP format that cannot be opened in this version of SLEAP.
                </DialogDescription>
              ) : prompt.kind === "upgrade-on-save" ? (
                <DialogDescription>
                  <span className="font-medium text-foreground">{prompt.fileName}</span>{" "}
                  was opened from an SLP 2.x file. Overwriting it will upgrade the file to SLP 3.0.
                </DialogDescription>
              ) : (
                <DialogDescription>
                  <span className="font-medium text-foreground">{prompt.fileName}</span>{" "}
                  is in SLP format {formatLabel(prompt.summary.formatId)}
                  {(prompt.summary.unreadTables?.length ?? 0) > 0
                    ? " and contains parts this version of SLEAP does not read."
                    : "."}
                </DialogDescription>
              )}
            </DialogHeader>

            {prompt.kind === "refused" && <RefusedBody prompt={prompt} />}

            {prompt.kind === "open" && (
              <div className="flex flex-col gap-3 text-sm">
                <p>
                  <span className="font-medium">View only</span> opens it with
                  editing off. Nothing is written back unless you allow editing.
                </p>
                <p>
                  <span className="font-medium">Edit</span> allows changes and
                  saves in SLP format {formatLabel(prompt.summary.formatId)}.
                </p>
                <DropList summary={prompt.summary} />
              </div>
            )}

            {prompt.kind === "merge" && (
              <div className="flex flex-col gap-3 text-sm">
                <p>
                  Merging adds its labels to this project. Saving writes SLP
                  format {formatLabel(prompt.summary.formatId)}.
                </p>
                <DropList summary={prompt.summary} />
              </div>
            )}

            {prompt.kind === "allow-edit" && (
              <div className="flex flex-col gap-3 text-sm">
                <p>{allowEditText(prompt.action).message}</p>
                <DropList summary={prompt.summary} />
              </div>
            )}

            {prompt.kind === "upgrade-on-save" && (
              <UpgradeOnSaveBody summary={prompt.summary} />
            )}

            <div className="flex flex-wrap justify-end gap-2 pt-1">
              {prompt.kind === "refused" ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="slp-format-refusal-cancel"
                    onClick={() => respond("ok")}
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
                </>
              ) : (
                <>
                  <Button variant="outline" size="sm" onClick={() => respond(null)}>
                    Cancel
                  </Button>
                  {prompt.kind === "open" && (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => respond("keep")}>
                        {(prompt.summary.unreadTables?.length ?? 0) > 0
                          ? "Edit (drop unread tables)"
                          : "Edit"}
                      </Button>
                      <Button size="sm" onClick={() => respond("view")}>
                        View only
                      </Button>
                    </>
                  )}
                  {prompt.kind === "merge" && (
                    <Button size="sm" onClick={() => respond("keep")}>
                      Merge
                    </Button>
                  )}
                  {prompt.kind === "allow-edit" && (
                    <Button size="sm" onClick={() => respond("keep")}>
                      {allowEditText(prompt.action).button}
                    </Button>
                  )}
                  {prompt.kind === "upgrade-on-save" && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="slp-upgrade-export-v2"
                        onClick={() => respond("export-v2")}
                      >
                        Save 2.x Copy (Drop 3.0 Data)
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        data-testid="slp-upgrade-save-as"
                        onClick={() => respond("save-as")}
                      >
                        Save As New File…
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        data-testid="slp-upgrade-v3"
                        onClick={() => respond("upgrade-v3")}
                      >
                        Save as SLP 3.0
                      </Button>
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
