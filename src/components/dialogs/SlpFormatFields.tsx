/**
 * Reusable SLP output format controls (`auto` / `v3` / `v2` + `unlabeledAs`
 * when `v2` is selected), shared by `SaveSlpCopyDialog` and
 * `ExportPackageDialog`.
 *
 * When `v2` is selected, renders a live `DropList` powered by
 * {@link describeFormat3Drops} so users can see every unlabeled point,
 * metadata key, or carried column that would be dropped before writing.
 */
import { useState } from "react";
import type { Format3Summary, SlpVersion } from "@talmolab/sleap-io.js";
import type { UnlabeledAs } from "@/lib/slpFormatStatus";
import { ChevronDown, ChevronRight } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { describeFormat3Drops } from "@/lib/slpAccess";

export interface SlpFormatExportChoice {
  slpVersion: SlpVersion;
  unlabeledAs: UnlabeledAs;
}

export const DEFAULT_SLP_FORMAT_CHOICE: SlpFormatExportChoice = {
  slpVersion: "auto",
  unlabeledAs: "absent",
};

interface SlpFormatFieldsProps {
  value: SlpFormatExportChoice;
  onChange: (value: SlpFormatExportChoice) => void;
  /** Live format 3.0 feature summary for the project being exported. */
  summary: Format3Summary | null;
  /** What `slpVersion: "auto"` will write for this project right now. */
  effectiveAutoVersion: "v2" | "v3";
  /** Prefix for radio ids, unique per dialog. */
  idPrefix: string;
  /** Render collapsed under a compact toggle (used in ExportPackageDialog). */
  collapsible?: boolean;
}

function summaryBadgeText(
  value: SlpFormatExportChoice,
  effectiveAutoVersion: "v2" | "v3",
): string {
  if (value.slpVersion === "auto") {
    return `Auto (${effectiveAutoVersion === "v3" ? "SLP 3.0" : "SLP 2.x"})`;
  }
  return value.slpVersion === "v3" ? "SLP 3.0" : "SLP 2.x";
}

export function SlpFormatFields({
  value,
  onChange,
  summary,
  effectiveAutoVersion,
  idPrefix,
  collapsible = false,
}: SlpFormatFieldsProps) {
  const [expanded, setExpanded] = useState(!collapsible);
  const isV2 = value.slpVersion === "v2";
  const drops = summary ? describeFormat3Drops(summary) : [];
  const unlabeledCount = summary?.unlabeledPoints ?? 0;

  const body = (
    <div className="space-y-3">
      <RadioGroup
        value={value.slpVersion}
        onValueChange={(v) =>
          onChange({ ...value, slpVersion: v as SlpVersion })
        }
        className="space-y-1.5"
        aria-label="SLP format version"
      >
        <label
          htmlFor={`${idPrefix}-ver-auto`}
          className="flex items-start gap-2 text-xs cursor-pointer"
        >
          <RadioGroupItem
            value="auto"
            id={`${idPrefix}-ver-auto`}
            className="mt-0.5"
          />
          <div>
            <div className="font-medium text-foreground">
              Auto (recommended)
            </div>
            <div className="text-muted-foreground">
              Writes{" "}
              {effectiveAutoVersion === "v3"
                ? "SLP 3.0 (preserves unlabeled nodes & metadata)"
                : "SLP 2.x (compatible with SLEAP 1.x)"}
              .
            </div>
          </div>
        </label>

        <label
          htmlFor={`${idPrefix}-ver-v3`}
          className="flex items-start gap-2 text-xs cursor-pointer"
        >
          <RadioGroupItem
            value="v3"
            id={`${idPrefix}-ver-v3`}
            className="mt-0.5"
          />
          <div>
            <div className="font-medium text-foreground">
              SLP 3.0 (sleap-io &gt;= 0.10)
            </div>
            <div className="text-muted-foreground">
              Preserves unlabeled nodes and metadata. Requires SLEAP 0.2+ or
              sleap-io &gt;= 0.10.
            </div>
          </div>
        </label>

        <label
          htmlFor={`${idPrefix}-ver-v2`}
          className="flex items-start gap-2 text-xs cursor-pointer"
        >
          <RadioGroupItem
            value="v2"
            id={`${idPrefix}-ver-v2`}
            className="mt-0.5"
          />
          <div>
            <div className="font-medium text-foreground">
              SLP 2.x (SLEAP 1.x compatible)
            </div>
            <div className="text-muted-foreground">
              Legacy layout readable by older SLEAP and sleap-io &lt; 0.10.
            </div>
          </div>
        </label>
      </RadioGroup>

      {isV2 && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
          <div className="space-y-1.5">
            <div className="font-medium text-foreground">
              Unlabeled points in SLP 2.x
            </div>
            <RadioGroup
              value={value.unlabeledAs}
              onValueChange={(v) =>
                onChange({ ...value, unlabeledAs: v as UnlabeledAs })
              }
              className="space-y-1"
              aria-label="Unlabeled points handling"
            >
              <label
                htmlFor={`${idPrefix}-unlabeled-absent`}
                className="flex items-center gap-2 cursor-pointer"
              >
                <RadioGroupItem
                  value="absent"
                  id={`${idPrefix}-unlabeled-absent`}
                />
                <span>Save unlabeled as absent (hidden, no position)</span>
              </label>
              <label
                htmlFor={`${idPrefix}-unlabeled-error`}
                className="flex items-center gap-2 cursor-pointer"
              >
                <RadioGroupItem
                  value="error"
                  id={`${idPrefix}-unlabeled-error`}
                />
                <span>Refuse if unlabeled points exist</span>
              </label>
            </RadioGroup>
          </div>

          {value.unlabeledAs === "error" && unlabeledCount > 0 && (
            <p
              className="text-destructive"
              data-testid="slp-format-v2-unlabeled-refusal"
            >
              This project contains {unlabeledCount} unlabeled{" "}
              {unlabeledCount === 1 ? "node" : "nodes"} — export will be refused
              unless you choose &ldquo;Save unlabeled as absent&rdquo;.
            </p>
          )}

          {drops.length > 0 ? (
            <div
              className="space-y-1 text-amber-600 dark:text-amber-400"
              data-testid="slp-format-v2-drops"
            >
              <div className="font-medium">
                Saving as SLP 2.x will drop or convert:
              </div>
              <ul className="list-disc space-y-0.5 pl-4">
                {drops.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-muted-foreground">
              No format 3.0 data will be dropped in SLP 2.x.
            </p>
          )}
        </div>
      )}
    </div>
  );

  if (!collapsible) {
    return (
      <div className="space-y-2">
        <div className="text-sm font-medium">SLP format</div>
        {body}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border/70">
      <button
        type="button"
        data-testid="slp-format-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-accent/50 transition-colors"
      >
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          SLP format
        </span>
        <span className="text-muted-foreground">
          {summaryBadgeText(value, effectiveAutoVersion)}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/70 px-3 py-2.5">{body}</div>
      )}
    </div>
  );
}
