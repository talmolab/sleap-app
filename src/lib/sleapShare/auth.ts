/**
 * SLEAP Share authentication client (GitHub Device Authorization Flow, RFC 8628)
 * and credential persistence (desktop file via Rust command; browser localStorage).
 */

import { isTauri } from "@/lib/platform";
import { sleapCmd } from "@/lib/sleapPlugin";
import { getSleapShareBaseUrl } from "./config";

const AUTH_STORAGE_KEY = "sleap-share:auth";

export interface SleapShareCredentials {
  token: string;
  tokenId?: string;
  username: string;
  avatarUrl?: string;
  userId?: number;
  baseUrl: string;
}

export interface DeviceAuthStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUrlWithCode: string;
  expiresIn: number;
  interval: number;
}

export type DeviceAuthPollResult =
  | { status: "pending" }
  | { status: "slow_down"; retryAfter?: number }
  | { status: "expired"; message?: string }
  | {
      status: "success";
      token: string;
      tokenId?: string;
      user: { id: number; username: string; avatar: string };
    };

export interface SleapShareUserProfile {
  id: number;
  username: string;
  avatarUrl: string;
  email: string | null;
  isSuperuser: boolean;
  quota: {
    usedBytes: number;
    limitBytes: number;
    unlimited: boolean;
  };
  stats: {
    totalFiles: number;
    totalStorage: number;
  };
}

export interface SleapShareUserFile {
  shortcode: string;
  filename: string;
  name?: string;
  fileSize: number;
  createdAt: number;
  expiresAt: number | null;
  shareUrl: string;
  dataUrl: string;
  isPrivate: boolean;
}

/** Persist credentials (0600 JSON file on desktop; localStorage on web). */
export async function saveSleapShareCredentials(
  creds: SleapShareCredentials
): Promise<void> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(sleapCmd("sleap_share_save_credentials"), {
      json: JSON.stringify(creds),
    });
    return;
  }
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(creds));
    }
  } catch {
    /* ignore storage quota/privacy errors */
  }
}

/** Load persisted credentials, or null if signed out / mismatched baseUrl. */
export async function loadSleapShareCredentials(
  baseUrl = getSleapShareBaseUrl()
): Promise<SleapShareCredentials | null> {
  let raw: string | null = null;
  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      raw = await invoke<string | null>(sleapCmd("sleap_share_load_credentials"));
    } catch {
      raw = null;
    }
  } else {
    try {
      if (typeof localStorage !== "undefined") {
        raw = localStorage.getItem(AUTH_STORAGE_KEY);
      }
    } catch {
      raw = null;
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SleapShareCredentials>;
    if (!parsed.token || !parsed.username) return null;
    const credBase = (parsed.baseUrl || "https://slp.sh").replace(/\/+$/, "");
    if (credBase !== baseUrl.replace(/\/+$/, "")) return null;
    return {
      token: parsed.token,
      tokenId: parsed.tokenId,
      username: parsed.username,
      avatarUrl: parsed.avatarUrl,
      userId: parsed.userId,
      baseUrl: credBase,
    };
  } catch {
    return null;
  }
}

/** Clear locally stored credentials. */
export async function clearSleapShareCredentials(): Promise<void> {
  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke(sleapCmd("sleap_share_clear_credentials"));
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

/** Start GitHub device authorization on `baseUrl`. */
export async function startDeviceAuth(
  baseUrl = getSleapShareBaseUrl(),
  fetchImpl: typeof fetch = fetch
): Promise<DeviceAuthStartResult> {
  const origin = baseUrl.replace(/\/+$/, "");
  const res = await fetchImpl(`${origin}/api/auth/cli/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client: "app",
      clientLabel: isTauri ? "SLEAP App (Desktop)" : "SLEAP App (Web)",
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new Error(
      body?.message || body?.error || `Failed to start sign-in (${res.status})`
    );
  }
  const data = (await res.json()) as {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn?: number;
    interval?: number;
  };
  const sep = data.verificationUri.includes("?") ? "&" : "?";
  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode,
    verificationUri: data.verificationUri,
    verificationUrlWithCode: `${data.verificationUri}${sep}code=${encodeURIComponent(data.userCode)}`,
    expiresIn: data.expiresIn ?? 600,
    interval: data.interval ?? 5,
  };
}

/** Poll device authorization once. */
export async function pollDeviceAuthOnce(
  deviceCode: string,
  baseUrl = getSleapShareBaseUrl(),
  fetchImpl: typeof fetch = fetch
): Promise<DeviceAuthPollResult> {
  const origin = baseUrl.replace(/\/+$/, "");
  const res = await fetchImpl(`${origin}/api/auth/cli/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After")) || undefined;
    return { status: "slow_down", retryAfter };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new Error(
      body?.message || body?.error || `Sign-in polling failed (${res.status})`
    );
  }
  const data = (await res.json()) as {
    status: "pending" | "success" | "expired";
    token?: string;
    tokenId?: string;
    user?: { id: number; username: string; avatar: string };
    message?: string;
  };
  if (data.status === "success" && data.token && data.user) {
    return {
      status: "success",
      token: data.token,
      tokenId: data.tokenId,
      user: data.user,
    };
  }
  if (data.status === "expired") {
    return { status: "expired", message: data.message };
  }
  return { status: "pending" };
}

/** Fetch current authenticated user profile, superuser flag, and quota. */
export async function fetchSleapShareProfile(
  token: string,
  baseUrl = getSleapShareBaseUrl(),
  fetchImpl: typeof fetch = fetch
): Promise<SleapShareUserProfile | null> {
  const origin = baseUrl.replace(/\/+$/, "");
  const res = await fetchImpl(`${origin}/api/v1/user/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch SLEAP Share profile (${res.status})`);
  }
  const data = (await res.json()) as Partial<SleapShareUserProfile> & {
    id: number;
    username: string;
    avatarUrl?: string;
    stats?: { totalFiles: number; totalStorage: number };
  };
  const usedBytes = data.quota?.usedBytes ?? data.stats?.totalStorage ?? 0;
  return {
    id: data.id,
    username: data.username,
    avatarUrl: data.avatarUrl ?? "",
    email: data.email ?? null,
    isSuperuser: data.isSuperuser === true,
    quota: {
      usedBytes,
      limitBytes: data.quota?.limitBytes ?? 100 * 1024 ** 3,
      unlimited: data.quota?.unlimited ?? data.isSuperuser === true,
    },
    stats: {
      totalFiles: data.stats?.totalFiles ?? 0,
      totalStorage: data.stats?.totalStorage ?? usedBytes,
    },
  };
}

/** List the authenticated user's active SLEAP Share uploads. */
export async function fetchSleapShareUserFiles(
  token: string,
  baseUrl = getSleapShareBaseUrl(),
  limit = 50,
  fetchImpl: typeof fetch = fetch
): Promise<SleapShareUserFile[]> {
  const origin = baseUrl.replace(/\/+$/, "");
  const res = await fetchImpl(
    `${origin}/api/v1/user/files?limit=${encodeURIComponent(String(limit))}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (res.status === 401) {
    throw new Error("SLEAP Share session expired. Please sign in again.");
  }
  if (!res.ok) {
    throw new Error(`Failed to load uploads (${res.status})`);
  }
  const data = (await res.json()) as { files?: SleapShareUserFile[] };
  return Array.isArray(data.files) ? data.files : [];
}

/** Best-effort server token revocation + local credential removal. */
export async function signOutSleapShare(
  creds: SleapShareCredentials | null,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (creds?.token && creds?.tokenId) {
    const origin = creds.baseUrl.replace(/\/+$/, "");
    await fetchImpl(
      `${origin}/api/v1/auth/tokens/${encodeURIComponent(creds.tokenId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${creds.token}` },
      }
    ).catch(() => {});
  }
  await clearSleapShareCredentials();
}
