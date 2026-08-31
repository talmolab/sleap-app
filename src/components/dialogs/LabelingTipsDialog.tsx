/**
 * Labeling Tips Dialog (#341).
 *
 * A reference page for the same pitfalls/shortcuts the ambient "gentle hint"
 * toasts cover (`lib/labelingHints.tsx`) — for anyone who dismissed those, or
 * who'd rather read everything up front instead of hitting each hint in the
 * moment. Content mirrors the legacy PyQt SLEAP tutorial/learnings docs
 * (../sleap/docs/tutorial/initial-labeling.md, correcting-predictions.md,
 * ../sleap/docs/learnings/prediction-assisted-labeling.md) translated to
 * sleap-app's actual menu names and shortcuts, not copied verbatim — some
 * PyQt-specific instructions (e.g. "right-click → Default") don't apply here.
 */

import { formatShortcut } from "@/lib/formatShortcut";
import { rgbToCSS, type RGB } from "@/lib/colorPalettes";
import {
  COMPLETE_COLOR,
  INCOMPLETE_COLOR,
  UNCOLORED_PREDICTED_NODE_COLOR,
  MISSING_LABEL_COLOR,
} from "@/canvas/SkeletonRenderer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface LabelingTipsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded font-mono">
      {children}
    </kbd>
  );
}

/** A node-color-coded label — same RGB constants the canvas renderer and the
 *  node-hover tooltip use, so this page can't visually drift out of sync with
 *  what's actually drawn. */
function ColorLabel({ color, children }: { color: RGB; children: React.ReactNode }) {
  return <strong style={{ color: rgbToCSS(color) }}>{children}</strong>;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-1.5 text-foreground">{title}</h3>
      <ul className="space-y-1.5 text-sm text-muted-foreground list-disc pl-5 marker:text-muted-foreground/50">
        {children}
      </ul>
    </div>
  );
}

export function LabelingTipsDialog({ open, onOpenChange }: LabelingTipsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Labeling Tips</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <Section title="Node colors">
            <li>
              <ColorLabel color={UNCOLORED_PREDICTED_NODE_COLOR}>Yellow</ColorLabel>{" "}
              — a prediction. Not used for training until you convert it to a
              user label.
            </li>
            <li>
              <ColorLabel color={INCOMPLETE_COLOR}>Red</ColorLabel> — a
              user-label node placed but not yet verified by you (auto-placed,
              or carried over from a converted prediction). If its position
              already looks right, you don't need to touch it — leaving it
              red is fine.
            </li>
            <li>
              <ColorLabel color={COMPLETE_COLOR}>Green</ColorLabel> —
              verified: you clicked or dragged this node to confirm or fix its
              position. Only nodes that actually needed correcting need to
              become green.
            </li>
            <li>
              <ColorLabel color={MISSING_LABEL_COLOR}>Hollow / grey</ColorLabel>{" "}
              — a node marked <em>not visible</em>. Right-click a node to
              toggle this directly, or hover/select it and press{" "}
              <Kbd>{formatShortcut("KeyV")}</Kbd>. Mark genuinely occluded
              nodes not-visible instead of guessing a position — SLEAP trains
              on that correctly, rather than learning an overconfident wrong
              location.
            </li>
          </Section>

          <Section title="User labeling — creating instances from scratch">
            <li>
              Right-click the canvas → <strong>Add Instance</strong>, or{" "}
              <Kbd>{formatShortcut("$mod+KeyI")}</Kbd>. Pick a placement
              method (Best / Template / Force Directed / Random / Copy Prior
              Frame / Copy Predictions) from Labels menu →{" "}
              <strong>Instance Placement Method</strong>.
            </li>
            <li>
              Already have a similarly-posed animal in the frame? Hold{" "}
              <Kbd>{formatShortcut("Ctrl")}</Kbd> and drag any node of that
              instance to clone it — usually faster than placing points from
              scratch.
            </li>
            <li>
              To move a <em>whole</em> instance at once instead of
              repositioning each node individually, double-click any node to
              select all of them, then drag any one.
            </li>
            <li>
              With an instance selected, hold <Kbd>{formatShortcut("Alt")}</Kbd>{" "}
              and scroll to rotate it.
            </li>
            <li>
              If a node is hidden or occluded in the frame, right-click it (or
              select it and press <Kbd>{formatShortcut("KeyV")}</Kbd>) to mark
              it not-visible instead of placing it at a guessed position. NOTE: The location of the invisible nodes doesn't affect training,
              the nodes marked as invisible will be ignored while training the model!
            </li>
          </Section>

          <Section title="Predictions → user labels">
            <li>
              Double-click a predicted (yellow) instance to convert it into an
              editable user instance — its nodes clone the prediction's
              positions and can then be dragged.
            </li>
            <li>
              To accept everything on the current frame at once:{" "}
              <Kbd>{formatShortcut("$mod+Shift+KeyA")}</Kbd> (Labels menu →{" "}
              <strong>Accept All Predictions on Current Frame</strong>), or
              Labels menu → <strong>Accept All Predictions</strong> for the
              whole project.
            </li>
            <li>
              A converted prediction can have nodes the model couldn't
              detect — these appear near the instance, hollow/grey and
              already marked not-visible. Right-click one if you can pinpoint
              its real location; otherwise it's fine to leave as-is.
            </li>
            <li>
              Predictions are <strong>not</strong> training data until
              converted — make sure every visible animal in the frame has a
              converted user label, not just the ones a prediction happened
              to cover.
            </li>
            <li>
              Predictions you don't want can be discarded without converting
              them — all from the Labels menu: <strong>Delete Predictions on
              Current Frame</strong>; <strong>Delete Predictions...</strong>{" "}
              (by score threshold, frame range, user-labeled frames, max
              instances per frame, track, or instance type);{" "}
              <strong>Delete Predictions from Area...</strong> (
              <Kbd>{formatShortcut("$mod+KeyK")}</Kbd>, drag a rectangle on
              the canvas); or <strong>Delete All Predictions...</strong> for
              the whole project.
            </li>
          </Section>

          <p className="text-xs text-muted-foreground/70 pt-1 border-t border-border">
            These same tips also show up as contextual "💡 Tip" toasts while
            you label — see <strong>Labels → Show Hints During Labeling</strong>{" "}
            to turn them on or off. For the full guided walkthrough, click{" "}
            <strong>Start Tutorial</strong> in the menu bar, or see{" "}
            <a
              href="https://docs.sleap.ai/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              docs.sleap.ai
            </a>
            .
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
