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

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { APP_VERSION, APP_VERSION_KIND_LABEL } from "@/lib/version";
import { isTauri } from "@/lib/platform";

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
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
            <p className="text-muted-foreground">
              Version {APP_VERSION}
              {" · "}
              <span data-testid="about-version-kind">
                {APP_VERSION_KIND_LABEL}
              </span>
            </p>
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
