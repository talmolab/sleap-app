import { useEffect, useRef } from "react";
import { AppShell } from "./components/layout/AppShell";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useAppStore } from "./stores/appStore";
import { applyHashState, initUrlStateSync } from "./lib/urlState";

export default function App() {
  useKeyboardShortcuts();
  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const hashApplied = useRef(false);

  useEffect(() => {
    // Prevent browser default drag-and-drop behavior
    const prevent = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Apply hash state once after project loads, then start syncing
  useEffect(() => {
    if (!projectLoaded) return;
    if (!hashApplied.current) {
      applyHashState();
      hashApplied.current = true;
    }
    return initUrlStateSync();
  }, [projectLoaded]);

  return <AppShell />;
}
