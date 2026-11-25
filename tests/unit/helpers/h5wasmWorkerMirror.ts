/**
 * Open an HDF5 file with REAL h5wasm (node build) behind the same API and
 * semantics as sleap-io.js's `StreamingH5File` worker (`h5-worker.ts`):
 * `getKeys` returns `[]` for a dataset, `getDatasetMeta` on a group gives an
 * undefined `shape`, and `getAttrs` wraps every value as `{ value }` (bytes
 * decoded to text). The worker itself can't start under `bun test`
 * (`importScripts`), so tests that care about real file shapes use this.
 */
import h5wasm from "h5wasm/node";

export interface MirroredH5 {
  keys(): string[];
  getKeys(path: string): Promise<string[]>;
  getDatasetMeta(path: string): Promise<{ shape: number[]; dtype: string }>;
  getAttrs(path: string): Promise<Record<string, unknown>>;
  getDatasetValue(
    path: string,
    slice?: Array<[number, number] | []>
  ): Promise<{ value: unknown; shape: number[]; dtype: string }>;
  close(): Promise<void>;
}

type Item = {
  keys?: () => string[];
  attrs?: Record<string, { value?: unknown }>;
  shape?: number[];
  dtype?: string;
  value?: unknown;
  slice?: (ranges: Array<[number, number] | []>) => unknown;
};

/** Same wrapping as the worker's `serializeAttrValue`. */
function serializeAttrValue(attr: { value?: unknown } | undefined) {
  if (!attr) return null;
  const val = attr.value !== undefined ? attr.value : attr;
  if (val instanceof Uint8Array) return { value: new TextDecoder().decode(val) };
  return { value: val };
}

export async function openWithRealH5wasm(path: string): Promise<MirroredH5> {
  await h5wasm.ready;
  const file = new h5wasm.File(path, "r");
  const get = (p: string): Item => {
    const item = (p === "/" || !p ? file : file.get(p)) as unknown as Item | null;
    if (!item) throw new Error("Path not found: " + p);
    return item;
  };
  return {
    keys: () => file.keys(),
    getKeys: async (p) => {
      const item = get(p);
      return item.keys ? item.keys() : [];
    },
    getDatasetMeta: async (p) => {
      const d = get(p);
      return { shape: d.shape as number[], dtype: d.dtype as string };
    },
    getAttrs: async (p) => {
      const raw = get(p).attrs ?? {};
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(raw)) out[key] = serializeAttrValue(raw[key]);
      return out;
    },
    getDatasetValue: async (p, slice) => {
      const d = get(p);
      const value = slice && d.slice ? d.slice(slice) : d.value;
      return { value, shape: d.shape as number[], dtype: d.dtype as string };
    },
    close: async () => {
      file.close();
    },
  };
}
