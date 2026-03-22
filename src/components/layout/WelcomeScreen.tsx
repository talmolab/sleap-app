/**
 * Welcome screen shown when no project is loaded.
 * Provides buttons to open a project or drag-and-drop an SLP file.
 */

import { useCallback } from "react";
import { useFileIO } from "../../hooks/useFileIO";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { modKey } from "../../lib/platform";

export function WelcomeScreen() {
  const { openProject, openFromDrop, loading, error } = useFileIO();

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith(".slp")) {
        openFromDrop(file);
      }
    },
    [openFromDrop]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  return (
    <div
      className="flex-1 flex items-center justify-center relative"
      style={{
        backgroundImage: `url(${import.meta.env.BASE_URL}background.jpg)`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Dim overlay */}
      <div className="absolute inset-0 bg-background/85" />

      <Card className="relative z-10 w-full max-w-md border-border bg-card/95 backdrop-blur-sm py-8">
        <CardContent className="flex flex-col items-center text-center space-y-6">
          <img src={`${import.meta.env.BASE_URL}icon.png`} alt="SLEAP" className="w-16 h-16" />

          <div>
            <h1 className="text-2xl font-bold text-foreground">
              SLEAP Label
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Open a SLEAP project (.slp) to start labeling
            </p>
          </div>

          <Button
            onClick={openProject}
            disabled={loading}
            size="lg"
            className="w-full max-w-[200px]"
          >
            {loading ? "Loading..." : "Open Project"}
          </Button>

          <div className="w-full border-2 border-dashed border-border rounded-lg p-6 text-muted-foreground text-sm">
            or drag and drop a .slp file here
          </div>

          {error && (
            <div className="w-full text-sm text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/20">
              {error}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Keyboard shortcut: {modKey}+O
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
