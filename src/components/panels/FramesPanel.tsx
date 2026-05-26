/**
 * Frames panel: lists all labeled frames in the project.
 *
 * Shows video name, frame index, instance counts, and prediction scores
 * for each labeled frame in a compact table.
 */

import { useState, useMemo } from "react";
import { useAppStore } from "../../stores/appStore";
import { cn } from "@/lib/utils";
import { Instance } from "@talmolab/sleap-io.js";
import type { Video } from "../../types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { LayoutGrid } from "lucide-react";

/** Extract just the basename from a file path. */
function basename(path: string | string[]): string {
  const p = Array.isArray(path) ? path[0] ?? "" : path;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

export const COLUMNS = [
  { key: "video",   label: "Video",  type: "string",  align: "left",   defaultVisible: true,  tooltip: "Video filename" },
  { key: "frame",   label: "Frame",  type: "number",  align: "right",  defaultVisible: true,  tooltip: "Frame index (0-based)" },
  { key: "neg",     label: "Neg",    type: "boolean", align: "center", defaultVisible: false, tooltip: "Negative/background training frame" },
  { key: "total",   label: "Total",  type: "number",  align: "right",  defaultVisible: false, tooltip: "Total instances (user + predicted)" },
  { key: "user",    label: "User",   type: "number",  align: "right",  defaultVisible: true,  tooltip: "User-labeled instance count" },
  { key: "pred",    label: "Pred",   type: "number",  align: "right",  defaultVisible: true,  tooltip: "Predicted instance count" },
  { key: "used",    label: "Used",   type: "number",  align: "right",  defaultVisible: false, tooltip: "Consumed predictions (accepted as labels)" },
  { key: "low",     label: "Low",    type: "number",  align: "right",  defaultVisible: false, tooltip: "Predictions with score below threshold" },
  { key: "score",   label: "Score",  type: "score",   align: "right",  defaultVisible: true,  tooltip: "Mean prediction score (0-1)" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

export interface FrameRowData {
  video: Video;
  videoName: string;
  frame: number;
  neg: boolean;
  total: number;
  user: number;
  pred: number;
  used: number;
  low: number;
  score: number | null;
}

/** Render a single cell value based on column key. */
function renderCell(row: FrameRowData, key: ColumnKey) {
  switch (key) {
    case "video":
      return (
        <TableCell
          key={key}
          className="py-0.5 px-2 text-xs max-w-[120px] truncate"
          title={row.videoName}
        >
          {row.videoName}
        </TableCell>
      );
    case "frame":
      return (
        <TableCell key={key} className="py-0.5 px-2 text-xs text-right tabular-nums">
          {row.frame}
        </TableCell>
      );
    case "neg":
      return (
        <TableCell key={key} className="py-0.5 px-2 text-xs text-center">
          {row.neg && (
            <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
          )}
        </TableCell>
      );
    case "score":
      return (
        <TableCell key={key} className="py-0.5 px-2 text-xs text-right tabular-nums">
          {row.score !== null ? (
            <span
              className={cn(
                row.score < 0.5
                  ? "text-red-500"
                  : row.score <= 0.8
                    ? "text-yellow-500"
                    : "text-green-500"
              )}
            >
              {row.score.toFixed(2)}
            </span>
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </TableCell>
      );
    default:
      return (
        <TableCell key={key} className="py-0.5 px-2 text-xs text-right tabular-nums">
          {row[key as keyof FrameRowData] as number}
        </TableCell>
      );
  }
}

export function FramesPanel() {
  const labels = useAppStore((s) => s.labels);
  const currentVideo = useAppStore((s) => s.video);
  const currentFrameIdx = useAppStore((s) => s.frameIdx);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);

  const [sortKey, setSortKey] = useState<ColumnKey>("frame");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [searchText, setSearchText] = useState("");
  const [visibleCols, setVisibleCols] = useState<Set<ColumnKey>>(
    () => new Set(COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key))
  );

  const visibleColumns = useMemo(
    () => COLUMNS.filter((c) => visibleCols.has(c.key)),
    [visibleCols]
  );

  const toggleSort = (key: ColumnKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortIndicator = (key: ColumnKey) => {
    if (sortKey !== key) return null;
    return sortDir === "asc" ? " ▲" : " ▼";
  };

  const rows: FrameRowData[] = useMemo(() => {
    if (!labels) return [];

    return labels.labeledFrames.map((lf) => {
      const userInstances = lf.userInstances;
      const predicted = lf.predictedInstances;

      const score =
        predicted.length > 0
          ? predicted.reduce((sum, pi) => sum + pi.score, 0) / predicted.length
          : null;

      return {
        video: lf.video,
        videoName: basename(lf.video.filename),
        frame: lf.frameIdx,
        neg: lf.isNegative,
        total: lf.instances.length,
        user: userInstances.length,
        pred: predicted.length,
        used: userInstances.filter(
          (i) => i instanceof Instance && (i as Instance).fromPredicted
        ).length,
        low: predicted.filter((pi) => pi.score < 0.5).length,
        score,
      };
    });
  }, [labels]);

  const searchFiltered = useMemo(() => {
    if (!searchText) return rows;
    const q = searchText.toLowerCase();
    return rows.filter((row) =>
      visibleColumns.some((col) => {
        const v = row[col.key as keyof FrameRowData];
        if (v === null || v === undefined) return false;
        return String(v).toLowerCase().includes(q);
      })
    );
  }, [rows, searchText, visibleColumns]);

  const sortedRows = useMemo(() => {
    if (searchFiltered.length === 0) return searchFiltered;

    const col = COLUMNS.find((c) => c.key === sortKey);
    if (!col) return searchFiltered;

    const sorted = [...searchFiltered].sort((a, b) => {
      const aVal = sortKey === "video" ? a.videoName : a[sortKey as keyof FrameRowData];
      const bVal = sortKey === "video" ? b.videoName : b[sortKey as keyof FrameRowData];

      // Null values sort before non-null in ascending
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return sortDir === "asc" ? -1 : 1;
      if (bVal === null) return sortDir === "asc" ? 1 : -1;

      let cmp = 0;
      if (col.type === "string") {
        cmp = String(aVal).localeCompare(String(bVal));
      } else if (col.type === "number" || col.type === "score") {
        cmp = (aVal as number) - (bVal as number);
      } else if (col.type === "boolean") {
        // false before true in ascending
        cmp = (aVal === bVal) ? 0 : (aVal ? 1 : -1);
      }

      return sortDir === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [searchFiltered, sortKey, sortDir]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-2 py-1.5 border-b border-border space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-xs shrink-0">
            {sortedRows.length === rows.length
              ? `${rows.length} frame${rows.length !== 1 ? "s" : ""}`
              : `${sortedRows.length} of ${rows.length} frames`}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            type="text"
            placeholder="Search frames..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="h-7 text-xs flex-1"
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                <LayoutGrid className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 p-2">
              <p className="text-xs font-medium mb-2">Visible Columns</p>
              {COLUMNS.map((col) => (
                <label
                  key={col.key}
                  className="flex items-center gap-2 py-1 px-1 text-xs text-muted-foreground hover:bg-muted rounded cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={visibleCols.has(col.key)}
                    onChange={() => {
                      setVisibleCols((prev) => {
                        const next = new Set(prev);
                        if (next.has(col.key)) {
                          if (next.size > 1) next.delete(col.key);
                        } else {
                          next.add(col.key);
                        }
                        return next;
                      });
                    }}
                    className="accent-orange-500"
                  />
                  {col.label}
                </label>
              ))}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Table */}
      <ScrollArea className="flex-1">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">
            No labeled frames
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-b hover:bg-transparent">
                {visibleColumns.map((col) => (
                  <TableHead
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className={cn(
                      "py-1 px-2 text-xs font-normal h-auto cursor-pointer select-none",
                      col.align === "right" && "text-right",
                      (col.align as string) === "center" && "text-center"
                    )}
                  >
                    {col.label}{sortIndicator(col.key)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedRows.map((row, idx) => (
                <TableRow
                  key={`${row.videoName}-${row.frame}-${idx}`}
                  onClick={() => {
                    if (row.video !== currentVideo) setVideo(row.video);
                    setFrameIdx(row.frame);
                  }}
                  className={cn(
                    "cursor-pointer border-b-0",
                    row.video === currentVideo && row.frame === currentFrameIdx
                      ? "bg-orange-500/10 border-l-2 border-l-orange-500 text-foreground"
                      : "hover:bg-muted/50 text-foreground"
                  )}
                >
                  {visibleColumns.map((col) => renderCell(row, col.key))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ScrollArea>

      {/* Footer */}
      <div className="px-2 py-1.5 border-t border-border">
        <span className="text-xs text-muted-foreground">
          {sortedRows.length === rows.length
            ? `${rows.length} frames`
            : `${sortedRows.length} of ${rows.length} frames`}
        </span>
      </div>
    </div>
  );
}
