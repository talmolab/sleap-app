/**
 * Capture the per-session Tauri invoke key so a Web Worker can call
 * `plugin:sleap|read_range` directly (off-main-thread video decode).
 *
 * Tauri v2 gates its custom-protocol IPC (`fetch("ipc://localhost/<cmd>")`, or
 * `http://ipc.localhost/<cmd>` on Windows) behind a `Tauri-Invoke-Key` header.
 * The key is a per-app-run secret held as a CLOSURE variable in Tauri's injected
 * bootstrap — it is NOT exposed on `window`/`__TAURI_INTERNALS__`. The only way to
 * read it from app code is to observe the header Tauri sets on a real invoke, so
 * we briefly wrap `Headers.prototype.set` around one invoke and record the value.
 * It is constant for the app's lifetime, so we capture once and cache. Verified by
 * the 2026-09-07 spike (macOS + Windows). See `docs/plans/2026-09-07-offmain-decode-*`.
 *
 * @module
 */

let cachedKey: string | null = null;

/** The invoke key captured so far, or null if not yet captured. */
export function getCachedInvokeKey(): string | null {
  return cachedKey;
}

/** Test-only: reset the cached key. */
export function __resetInvokeKeyForTest(): void {
  cachedKey = null;
}

/**
 * Capture the Tauri invoke key by wrapping `Headers.prototype.set` for the
 * duration of one real invoke (provided by `triggerInvoke`), then restore it.
 * Idempotent + cached: returns the cached key immediately once known, without
 * wrapping again. Resolves null if the header was never seen (e.g. not in Tauri,
 * or the transport changed). Never throws (a failing `triggerInvoke` is
 * swallowed — Tauri sets the header before the command dispatches, so even a
 * command error still yields the key).
 */
export async function captureInvokeKey(
  triggerInvoke: () => Promise<unknown>,
): Promise<string | null> {
  if (cachedKey) return cachedKey;

  const proto = Headers.prototype;
  const original = proto.set;
  let captured: string | null = null;
  proto.set = function patchedSet(name: string, value: string): void {
    try {
      if (typeof name === "string" && name.toLowerCase() === "tauri-invoke-key") {
        captured = value;
      }
    } catch {
      // ignore — never let the probe break a real header write
    }
    return original.call(this, name, value);
  };

  try {
    await triggerInvoke();
  } catch {
    // ignore — the header is set before dispatch, so a command error is fine
  } finally {
    proto.set = original;
  }

  if (captured) cachedKey = captured;
  return cachedKey;
}
