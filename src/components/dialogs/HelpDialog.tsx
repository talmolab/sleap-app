/**
 * Help / About Dialog.
 *
 * Shows application name, version, and credits.
 *
 * The version is read from @/lib/version, never written inline: CI stamps it
 * per build (build.yml from the release tag for the desktop bundle, deploy.yml
 * per web target), so the same source drives this dialog, the window/tab title
 * and the Environment panel on both platforms. It used to be a hardcoded
 * "Version 0.1.0" string, which meant the one place a user would look to check
 * what they were running was the one place guaranteed to be wrong.
 */

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { APP_VERSION, APP_VERSION_KIND_LABEL } from "@/lib/version";
import { isTauri } from "@/lib/platform";
import { getInstallId } from "@/lib/diagnostics/sessionLog";

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  const [copiedId, setCopiedId] = useState(false);
  const supportId = getInstallId();

  const handleCopySupportId = () => {
    try {
      void navigator.clipboard?.writeText(supportId);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    } catch {
      /* ignore clipboard failure */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>About SLEAP Label</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2 text-sm">
          <div>
            <p className="font-semibold">
              {isTauri ? "SLEAP Label Desktop" : "SLEAP Label Web"}
            </p>
            <p className="text-muted-foreground select-text">
              Version {APP_VERSION}
              {" · "}
              <span data-testid="about-version-kind">
                {APP_VERSION_KIND_LABEL}
              </span>
            </p>
            {/* The random per-install id that diagnostics bundles and usage
                data carry. Quoting it in a bug report lets us find the errors
                this install reported; it identifies the install, not a person. */}
            <div
              className="flex items-center gap-1.5 text-xs text-muted-foreground select-text"
              title="A random ID for this install. Include it when you report an issue so we can find the errors it reported."
            >
              <span>Support ID</span>
              <code data-testid="about-support-id" className="font-mono">
                {supportId}
              </code>
              <button
                type="button"
                data-testid="copy-support-id"
                onClick={handleCopySupportId}
                aria-label="Copy Support ID"
                title={copiedId ? "Copied" : "Copy Support ID"}
                className="inline-flex items-center p-0.5 rounded hover:bg-accent/60 hover:text-foreground transition-colors"
              >
                {copiedId ? (
                  <Check className="h-3.5 w-3.5 text-green-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          <p className="text-muted-foreground">
            Web-based labeling interface for SLEAP (Social LEAP Estimates Animal
            Poses). Built with React, TypeScript, and Canvas 2D.
          </p>

          <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t border-border">
            <p>
              SLEAP is developed by the{" "}
              <a
                href="https://talmolab.org"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                Talmo Lab
              </a>
              .
            </p>
            <p>
              <a
                href="https://sleap.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                sleap.ai
              </a>
              {" | "}
              <a
                href="https://github.com/talmolab/sleap"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                GitHub
              </a>
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
