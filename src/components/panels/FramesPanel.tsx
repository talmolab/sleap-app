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
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { LayoutGrid, ListFilter } from "lucide-react";

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
  { key: "recent",  label: "Recent", type: "number",  align: "right",  defaultVisible: false, tooltip: "Recently interacted frame" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

type FilterOp = "==" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "is";

interface ColumnFilter {
  key: ColumnKey;
  op: FilterOp;
  value: string;
}

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
  recent: number | null;
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
    case "recent":
      return (
        <TableCell key={key} className="py-0.5 px-2 text-xs text-center">
          {row.recent !== null && (
            <span className="inline-block w-2 h-2 rounded-full bg-blue-500" title={`Rank: ${row.recent}`} />
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

/** Get the default filter operator for a column type. */
function getDefaultOp(type: string): FilterOp {
  if (type === "string") return "contains";
  if (type === "boolean") return "is";
  return ">=";
}

/** Format a filter as a human-readable label. */
function formatFilterLabel(f: ColumnFilter): string {
  const col = COLUMNS.find((c) => c.key === f.key);
  const label = col?.label ?? f.key;
  if (f.op === "is") return `${label} = ${f.value}`;
  if (f.op === "contains") return `${label} ⊃ "${f.value}"`;
  const opMap: Record<string, string> = {
    "==": "=",
    "!=": "≠",
    ">": ">",
    "<": "<",
    ">=": "≥",
    "<=": "≤",
  };
  return `${label} ${opMap[f.op] ?? f.op} ${f.value}`;
}

/** Check whether a single row passes one filter. */
function applyFilter(row: FrameRowData, f: ColumnFilter): boolean {
  const raw =
    f.key === "video" ? row.videoName : row[f.key as keyof FrameRowData];

  if (f.op === "contains")
    return String(raw ?? "")
      .toLowerCase()
      .includes(f.value.toLowerCase());
  if (f.op === "is") return f.value === "yes" ? raw === true : raw === false;

  if (raw === null || raw === undefined) return false;
  const numVal = Number(raw);
  const filterNum = Number(f.value);
  if (isNaN(numVal) || isNaN(filterNum)) return false;

  switch (f.op) {
    case "==":
      return numVal === filterNum;
    case "!=":
      return numVal !== filterNum;
    case ">":
      return numVal > filterNum;
    case "<":
      return numVal < filterNum;
    case ">=":
      return numVal >= filterNum;
    case "<=":
      return numVal <= filterNum;
    default:
      return true;
  }
}

/** Popover for configuring a filter on a single column. */
function FilterPopover({
  col,
  filters,
  onApply,
  onClear,
}: {
  col: (typeof COLUMNS)[number];
  filters: ColumnFilter[];
  onApply: (f: ColumnFilter) => void;
  onClear: (key: ColumnKey) => void;
}) {
  const existing = filters.find((f) => f.key === col.key);
  const [op, setOp] = useState<FilterOp>(
    existing?.op ?? getDefaultOp(col.type)
  );
  const [value, setValue] = useState(existing?.value ?? "");

  const stringOps: FilterOp[] = ["contains", "==", "!="];
  const numericOps: FilterOp[] = ["==", "!=", ">", "<", ">=", "<="];

  const opLabel: Record<string, string> = {
    contains: "contains",
    "==": "=",
    "!=": "≠",
    ">": ">",
    "<": "<",
    ">=": "≥",
    "<=": "≤",
    is: "is",
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          setOp(existing?.op ?? getDefaultOp(col.type));
          setValue(existing?.value ?? "");
        }
      }}
    >
      <PopoverTrigger asChild onClick={(e) => e.stopPropagation()}>
        <button
          className={cn(
            "ml-1 text-[10px] opacity-30 hover:opacity-100 transition-opacity",
            existing && "opacity-100 text-orange-500"
          )}
        >
          ▾
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-xs font-medium mb-2">Filter: {col.label}</p>

        {col.type === "boolean" ? (
          /* Boolean: radio buttons for Yes / No */
          <div className="flex gap-3">
            {(["yes", "no"] as const).map((v) => (
              <label key={v} className="flex items-center gap-1 text-xs">
                <input
                  type="radio"
                  name={`filter-${col.key}`}
                  checked={value === v}
                  onChange={() => setValue(v)}
                  className="accent-orange-500"
                />
                {v === "yes" ? "Yes" : "No"}
              </label>
            ))}
          </div>
        ) : (
          /* String / Number / Score */
          <>
            <Select
              value={op}
              onValueChange={(v) => setOp(v as FilterOp)}
            >
              <SelectTrigger size="sm" className="h-7 text-xs mb-2 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(col.type === "string" ? stringOps : numericOps).map((o) => (
                  <SelectItem key={o} value={o} className="text-xs">
                    {opLabel[o]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Input
              type={col.type === "string" ? "text" : "number"}
              placeholder={col.type === "string" ? "value" : "0"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-7 text-xs"
              step={col.type === "score" ? "0.01" : undefined}
            />

            {/* Score: synced range slider */}
            {col.type === "score" && (
              <Slider
                min={0}
                max={1}
                step={0.01}
                value={[value === "" ? 0 : Number(value)]}
                onValueChange={([v]) => setValue(String(v))}
                className="mt-2"
              />
            )}
          </>
        )}

        <div className="flex gap-2 mt-2">
          <Button
            variant="default"
            size="xs"
            onClick={() => onApply({ key: col.key, op, value })}
          >
            Apply
          </Button>
          {existing && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onClear(col.key)}
            >
              Clear
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Inline filter form used inside the "Add filter" popover. */
function AddFilterForm({
  col,
  onApply,
}: {
  col: (typeof COLUMNS)[number];
  onApply: (f: ColumnFilter) => void;
}) {
  const [op, setOp] = useState<FilterOp>(getDefaultOp(col.type));
  const [value, setValue] = useState("");

  const stringOps: FilterOp[] = ["contains", "==", "!="];
  const numericOps: FilterOp[] = ["==", "!=", ">", "<", ">=", "<="];

  const opLabel: Record<string, string> = {
    contains: "contains",
    "==": "=",
    "!=": "≠",
    ">": ">",
    "<": "<",
    ">=": "≥",
    "<=": "≤",
    is: "is",
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Filter: {col.label}</p>

      {col.type === "boolean" ? (
        <div className="flex gap-3">
          {(["yes", "no"] as const).map((v) => (
            <label key={v} className="flex items-center gap-1 text-xs">
              <input
                type="radio"
                name={`add-filter-${col.key}`}
                checked={value === v}
                onChange={() => setValue(v)}
                className="accent-orange-500"
              />
              {v === "yes" ? "Yes" : "No"}
            </label>
          ))}
        </div>
      ) : (
        <>
          <Select value={op} onValueChange={(v) => setOp(v as FilterOp)}>
            <SelectTrigger size="sm" className="h-7 text-xs w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(col.type === "string" ? stringOps : numericOps).map((o) => (
                <SelectItem key={o} value={o} className="text-xs">
                  {opLabel[o]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            type={col.type === "string" ? "text" : "number"}
            placeholder={col.type === "string" ? "value" : "0"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-7 text-xs"
            step={col.type === "score" ? "0.01" : undefined}
          />

          {col.type === "score" && (
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={[value === "" ? 0 : Number(value)]}
              onValueChange={([v]) => setValue(String(v))}
            />
          )}
        </>
      )}

      <Button
        variant="default"
        size="xs"
        onClick={() => onApply({ key: col.key, op, value })}
      >
        Apply
      </Button>
    </div>
  );
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
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const [addFilterCol, setAddFilterCol] = useState<ColumnKey | null>(null);
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

  const interactionStack = useAppStore((s) => s.frameInteractionStack);

  const rows: FrameRowData[] = useMemo(() => {
    if (!labels) return [];

    return labels.labeledFrames.map((lf) => {
      const userInstances = lf.userInstances;
      const predicted = lf.predictedInstances;

      const score =
        predicted.length > 0
          ? predicted.reduce((sum, pi) => sum + pi.score, 0) / predicted.length
          : null;

      const vidIdx = labels.videos.indexOf(lf.video);
      const key = `${vidIdx}:${lf.frameIdx}`;
      const stackIdx = interactionStack.lastIndexOf(key);
      const recent = stackIdx !== -1 ? interactionStack.length - stackIdx : null;

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
        recent,
      };
    });
  }, [labels, interactionStack]);

  const searchFiltered = useMemo(() => {
    if (!searchText) return rows;
    const q = searchText.toLowerCase();
    return rows.filter((row) =>
      visibleColumns.some((col) => {
        const v = col.key === "video" ? row.videoName : row[col.key as keyof FrameRowData];
        if (v === null || v === undefined) return false;
        return String(v).toLowerCase().includes(q);
      })
    );
  }, [rows, searchText, visibleColumns]);

  const filtered = useMemo(() => {
    if (filters.length === 0) return searchFiltered;
    return searchFiltered.filter((row) =>
      filters.every((f) => applyFilter(row, f))
    );
  }, [searchFiltered, filters]);

  /** Apply (add or replace) a filter for a given column. */
  const handleApplyFilter = (f: ColumnFilter) => {
    setFilters((prev) => {
      const without = prev.filter((p) => p.key !== f.key);
      return [...without, f];
    });
  };

  /** Clear the filter for a given column. */
  const handleClearFilter = (key: ColumnKey) => {
    setFilters((prev) => prev.filter((p) => p.key !== key));
  };

  const sortedRows = useMemo(() => {
    if (filtered.length === 0) return filtered;

    const col = COLUMNS.find((c) => c.key === sortKey);
    if (!col) return filtered;

    const sorted = [...filtered].sort((a, b) => {
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
  }, [filtered, sortKey, sortDir]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-2 py-1.5 border-b border-border space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-xs shrink-0">
            {filtered.length === rows.length
              ? `${rows.length} frame${rows.length !== 1 ? "s" : ""}`
              : `${filtered.length} of ${rows.length} frames`}
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

          {/* Add filter button */}
          <Popover onOpenChange={(open) => { if (!open) setAddFilterCol(null); }}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7 shrink-0",
                  filters.length > 0 && "text-orange-500"
                )}
              >
                <ListFilter className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-2">
              {addFilterCol === null ? (
                <>
                  <p className="text-xs font-medium mb-2">Add Filter</p>
                  {COLUMNS.map((col) => (
                    <button
                      key={col.key}
                      className="flex items-center w-full gap-2 py-1 px-1 text-xs text-muted-foreground hover:bg-muted rounded cursor-pointer"
                      onClick={() => setAddFilterCol(col.key)}
                    >
                      {col.label}
                      {filters.some((f) => f.key === col.key) && (
                        <span className="ml-auto text-orange-500 text-[10px]">active</span>
                      )}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground mb-2"
                    onClick={() => setAddFilterCol(null)}
                  >
                    &larr; Back
                  </button>
                  <AddFilterForm
                    col={COLUMNS.find((c) => c.key === addFilterCol)!}
                    onApply={(f) => {
                      handleApplyFilter(f);
                      setAddFilterCol(null);
                    }}
                  />
                </>
              )}
            </PopoverContent>
          </Popover>

          {/* Column visibility */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                <LayoutGrid className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 p-2 max-h-80 overflow-y-auto">
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

        {/* Active filter chips */}
        {filters.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {filters.map((f, i) => (
              <Badge key={i} variant="secondary" className="text-xs gap-1 pr-1">
                {formatFilterLabel(f)}
                <button
                  onClick={() =>
                    setFilters((prev) => prev.filter((_, j) => j !== i))
                  }
                  className="ml-0.5 hover:text-foreground"
                >
                  &times;
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Table */}
      <ScrollArea className="flex-1">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">
            No labeled frames
          </p>
        ) : (
          <Table className="w-max min-w-full">
            <TableHeader>
              <TableRow className="border-b hover:bg-transparent">
                {visibleColumns.map((col) => (
                  <TableHead
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className={cn(
                      "py-1 px-2 text-xs font-normal h-auto cursor-pointer select-none whitespace-nowrap",
                      col.align === "right" && "text-right",
                      (col.align as string) === "center" && "text-center"
                    )}
                  >
                    {col.label}{sortIndicator(col.key)}
                    <FilterPopover
                      col={col}
                      filters={filters}
                      onApply={handleApplyFilter}
                      onClear={handleClearFilter}
                    />
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
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      {/* Footer */}
      <div className="px-2 py-1.5 border-t border-border">
        <span className="text-xs text-muted-foreground">
          {filtered.length === rows.length
            ? `${rows.length} frames`
            : `${filtered.length} of ${rows.length} frames`}
        </span>
      </div>
    </div>
  );
}
