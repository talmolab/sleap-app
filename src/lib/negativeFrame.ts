/**
 * The one way the UI toggles Mark Frame as Negative (Labels menu, video
 * right-click menu, `N` shortcut). Like SLEAP (#2894), marking a frame that
 * still has instances asks first, because it removes them. The question is
 * asked here, before the command runs, so declining leaves no empty undo
 * step behind (the command context snapshots before every mutating command).
 */
import { commandContext } from "@/commands";
import type { CommandContext } from "@/commands/CommandContext";
import { ToggleNegativeFrame } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import { confirmDialog } from "@/stores/confirmStore";

export async function requestToggleNegativeFrame(ctx: CommandContext = commandContext): Promise<void> {
  const { labels, video, frameIdx } = useAppStore.getState();
  if (!labels || !video) return;
  const lf = labels.find({ video, frameIdx })[0];
  const n = lf && !lf.isNegative ? lf.instances.length : 0;
  if (n > 0) {
    const ok = await confirmDialog({
      title: "Mark frame as negative",
      message:
        `Frame ${frameIdx + 1} has ${n} instance${n === 1 ? "" : "s"}. ` +
        `Marking it as a negative (background) frame will remove ${n === 1 ? "it" : "them"}.\n\nContinue?`,
      confirmLabel: "Mark as Negative",
      destructive: true,
    });
    if (!ok) return;
  }
  await ctx.execute(ToggleNegativeFrame);
}
