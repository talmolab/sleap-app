/**
 * Zustand store for SLEAP Share dialog visibility, shared GitHub auth session,
 * and active remote-dataset provenance (future-proofs "update existing upload").
 */

import { create } from "zustand";
import {
  loadSleapShareCredentials,
  saveSleapShareCredentials,
  fetchSleapShareProfile,
  signOutSleapShare,
  clearSleapShareCredentials,
  type SleapShareCredentials,
  type SleapShareUserProfile,
} from "@/lib/sleapShare/auth";
import { getSleapShareBaseUrl } from "@/lib/sleapShare/config";

export interface ActiveShareSource {
  origin: string;
  shortcode: string;
  member: string;
  displayName?: string;
  isPrivate?: boolean;
}

interface SleapShareState {
  openFromShareDialogOpen: boolean;
  uploadToShareDialogOpen: boolean;
  setOpenFromShareDialogOpen: (open: boolean) => void;
  setUploadToShareDialogOpen: (open: boolean) => void;

  /** Loaded credentials (null when anonymous). */
  credentials: SleapShareCredentials | null;
  /** Latest profile/quota fetched from `/api/v1/user/me`. */
  profile: SleapShareUserProfile | null;
  authChecked: boolean;
  authLoading: boolean;

  /** Tracks when the open project originated from a SLEAP Share dataset. */
  activeShareSource: ActiveShareSource | null;
  setActiveShareSource: (source: ActiveShareSource | null) => void;
  /** Canonical remote URL of the open project (used for desktop window dedup). */
  activeRemoteUrl: string | null;
  setActiveRemoteUrl: (url: string | null) => void;

  /** Load saved credentials and verify/refresh profile from `/api/v1/user/me`. */
  hydrateAuth: (force?: boolean) => Promise<void>;
  /** Store freshly authenticated credentials + fetch profile. */
  setAuthenticated: (creds: SleapShareCredentials) => Promise<void>;
  /** Sign out, revoke token best-effort, and clear local credentials. */
  signOut: () => Promise<void>;
}

export const useSleapShareStore = create<SleapShareState>((set, get) => ({
  openFromShareDialogOpen: false,
  uploadToShareDialogOpen: false,
  setOpenFromShareDialogOpen: (open) => set({ openFromShareDialogOpen: open }),
  setUploadToShareDialogOpen: (open) => set({ uploadToShareDialogOpen: open }),

  credentials: null,
  profile: null,
  authChecked: false,
  authLoading: false,

  activeShareSource: null,
  setActiveShareSource: (source) => set({ activeShareSource: source }),
  activeRemoteUrl: null,
  setActiveRemoteUrl: (url) => set({ activeRemoteUrl: url }),

  hydrateAuth: async (force = false) => {
    const { authChecked, authLoading } = get();
    if (authLoading || (authChecked && !force)) return;
    set({ authLoading: true });
    try {
      const baseUrl = getSleapShareBaseUrl();
      const creds = await loadSleapShareCredentials(baseUrl);
      if (!creds) {
        set({ credentials: null, profile: null, authChecked: true });
        return;
      }
      set({ credentials: creds });
      try {
        const profile = await fetchSleapShareProfile(creds.token, creds.baseUrl);
        if (!profile) {
          // Token was revoked or expired on the server — clear stale creds.
          await clearSleapShareCredentials();
          set({ credentials: null, profile: null, authChecked: true });
          return;
        }
        set({
          credentials: {
            ...creds,
            username: profile.username,
            avatarUrl: profile.avatarUrl || creds.avatarUrl,
            userId: profile.id,
          },
          profile,
          authChecked: true,
        });
      } catch {
        // Network offline: keep credentials cached so user isn't forcibly signed out.
        set({ authChecked: true });
      }
    } finally {
      set({ authLoading: false });
    }
  },

  setAuthenticated: async (creds) => {
    await saveSleapShareCredentials(creds);
    set({ credentials: creds, authChecked: true });
    try {
      const profile = await fetchSleapShareProfile(creds.token, creds.baseUrl);
      if (profile) {
        const enriched: SleapShareCredentials = {
          ...creds,
          username: profile.username,
          avatarUrl: profile.avatarUrl || creds.avatarUrl,
          userId: profile.id,
        };
        await saveSleapShareCredentials(enriched);
        set({ credentials: enriched, profile });
      }
    } catch {
      /* non-fatal; credentials are already stored */
    }
  },

  signOut: async () => {
    const creds = get().credentials;
    set({ credentials: null, profile: null, authChecked: true });
    await signOutSleapShare(creds);
  },
}));
