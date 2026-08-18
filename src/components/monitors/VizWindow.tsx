import { useEffect } from "react";
import { VizViewer } from "@/components/monitors/VizViewer";

/**
 * Standalone visualization window content (spawned with `?viz=<runDir>`). Its own
 * isolated JS heap — no app store — so it just hosts a {@link VizViewer} pointed
 * at the run's viz dir on disk, filling the window. Defaults to the app's dark
 * theme (the window has no theme provider of its own).
 */
export function VizWindow({ runDir, title }: { runDir: string; title: string }) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <div className="dark h-screen w-screen flex flex-col bg-background text-foreground p-3 gap-2">
      <div className="text-sm font-medium shrink-0">Visualization — {title}</div>
      <div className="flex-1 min-h-0">
        <VizViewer runDir={runDir} fill />
      </div>
    </div>
  );
}
