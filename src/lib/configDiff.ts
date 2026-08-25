import type { ConfigHyperparams } from "@/stores/trainingStore";

/** A group of hyperparameter fields shown together in the config shell. */
export interface ConfigSectionFields {
  id: string;
  fields: readonly (keyof ConfigHyperparams)[];
}

/** Which fields differ from the baseline, and how many per section. */
export interface ConfigDiff {
  changedFields: Set<keyof ConfigHyperparams>;
  countBySection: Record<string, number>;
  totalChanged: number;
}

/**
 * Diff the current hyperparameters against the baseline they were seeded from,
 * scoped to the fields each section owns. Powers the "modified" dots and the
 * per-section change counts in the config shell's left rail. Only section-listed
 * fields are considered, so a value the UI doesn't surface never shows as changed.
 */
export function computeConfigDiff(
  current: ConfigHyperparams,
  baseline: ConfigHyperparams,
  sections: readonly ConfigSectionFields[],
): ConfigDiff {
  const changedFields = new Set<keyof ConfigHyperparams>();
  const countBySection: Record<string, number> = {};

  for (const section of sections) {
    let count = 0;
    for (const field of section.fields) {
      if (current[field] !== baseline[field]) {
        changedFields.add(field);
        count++;
      }
    }
    countBySection[section.id] = count;
  }

  return { changedFields, countBySection, totalChanged: changedFields.size };
}
