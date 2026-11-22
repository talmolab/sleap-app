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
  canSaveLegacyCopy,
  describeFormat3Drops,
  formatLabel,
  legacyCopyCommand,
  refusalReason,
} from "@/lib/slpAccess";
import type { Format3Summary } from "@/lib/slpFormatCompat";

/** What saving in the 2.x layout drops, as a list (or the lossless note). */
function DropList({ summary }: { summary: Format3Summary }) {
  const drops = describeFormat3Drops(summary);
  if (drops.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing in this file would be dropped, but saving rewrites it in the
        older 2.x layout.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">
        Saving writes the older 2.x layout, which drops:
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
            Python sleap-io 0.10 or newer. Nodes marked as not labelled are saved
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
  }
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
              {prompt.kind !== "refused" && (
                <DialogDescription>
                  <span className="font-medium text-foreground">{prompt.fileName}</span>{" "}
                  is in SLP format {formatLabel(prompt.summary.formatId)}. This
                  version of SLEAP reads it, but saves only the older 2.x layout.
                </DialogDescription>
              )}
            </DialogHeader>

            {prompt.kind === "refused" && <RefusedBody prompt={prompt} />}

            {prompt.kind === "open" && (
              <div className="flex flex-col gap-3 text-sm">
                <p>
                  <span className="font-medium">View only</span> opens it with
                  editing off. Nothing is ever written back to the file.
                </p>
                <p>
                  <span className="font-medium">Edit</span> allows changes.
                </p>
                <DropList summary={prompt.summary} />
              </div>
            )}

            {prompt.kind === "merge" && (
              <div className="flex flex-col gap-3 text-sm">
                <p>
                  Merging adds its labels to this project, which is then saved in
                  the 2.x layout.
                </p>
                <DropList summary={prompt.summary} />
              </div>
            )}

            {prompt.kind === "allow-edit" && (
              <div className="flex flex-col gap-3 text-sm">
                <p>
                  {prompt.action
                    ? `It was opened View only, so it can't be used to ${prompt.action} until editing is allowed.`
                    : "It was opened View only. Allowing editing lets you change and save it."}
                </p>
                <DropList summary={prompt.summary} />
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2 pt-1">
              {prompt.kind === "refused" ? (
                <Button size="sm" onClick={() => respond("ok")}>
                  OK
                </Button>
              ) : (
                <>
                  <Button variant="outline" size="sm" onClick={() => respond(null)}>
                    Cancel
                  </Button>
                  {prompt.kind === "open" && (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => respond("edit")}>
                        Edit
                      </Button>
                      <Button size="sm" onClick={() => respond("view")}>
                        View only
                      </Button>
                    </>
                  )}
                  {prompt.kind === "merge" && (
                    <Button size="sm" onClick={() => respond("edit")}>
                      Merge
                    </Button>
                  )}
                  {prompt.kind === "allow-edit" && (
                    <Button size="sm" onClick={() => respond("edit")}>
                      {prompt.action ? `Allow editing and ${prompt.action}` : "Allow editing"}
                    </Button>
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
