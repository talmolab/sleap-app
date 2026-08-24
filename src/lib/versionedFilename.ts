/**
 * Auto-versioned save filenames, following the legacy PyQt SLEAP convention
 * (`sleap/gui/commands.py:get_new_version_filename`).
 *
 * The name ground truth: a versioned label file ends in `.vNNN.slp`. Saving a
 * new copy increments the number, zero-padded to the width already present
 * (`labels.v001.slp` → `labels.v002.slp`, `labels.v099.slp` → `labels.v100.slp`).
 * A brand-new project seeds from `labels.v000.slp`, so its first save proposes
 * `labels.v001.slp`.
 *
 * DIVERGENCE FROM PyQt (intentional, agreed with the user): PyQt appends
 * " copy" to a name that has no `.vNNN` block. We instead START versioning by
 * inserting `.v001`, so imported / oddly-named files (`experiment.slp`) begin
 * versioning as `experiment.v001.slp` — better serving the "add versioning"
 * goal. Only the fallback differs; the increment algorithm matches PyQt exactly.
 *
 * Pure and directory-safe: it operates on the trailing `.vNNN.slp` / `.slp`, so
 * an absolute path prefix is preserved untouched.
 */
export function getNewVersionFilename(filename: string): string {
  const versioned = filename.match(/\.v(\d+)\.slp$/i);
  if (versioned) {
    const oldVer = versioned[1];
    const newVer = String(Number(oldVer) + 1).padStart(oldVer.length, "0");
    return filename.replace(/\.v\d+\.slp$/i, `.v${newVer}.slp`);
  }
  if (/\.slp$/i.test(filename)) {
    return filename.replace(/\.slp$/i, ".v001.slp");
  }
  return `${filename}.v001.slp`;
}
