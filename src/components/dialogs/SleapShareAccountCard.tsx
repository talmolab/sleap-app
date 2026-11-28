/**
 * Compact SLEAP Share GitHub account card shared by the "Open from SLEAP Share"
 * and "Upload to SLEAP Share" dialogs.
 *
 * Uses RFC 8628 GitHub Device Authorization (`/api/auth/cli/start` + `/poll`)
 * so both Web and Desktop sign in cleanly without OAuth redirect handlers or
 * embedded webviews.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  LogIn,
  LogOut,
  ShieldCheck,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { openExternal } from "@/lib/menu/menuActions";
import { toast } from "@/lib/notify";
import { useSleapShareStore } from "@/stores/sleapShareStore";
import {
  pollDeviceAuthOnce,
  startDeviceAuth,
  type DeviceAuthStartResult,
} from "@/lib/sleapShare/auth";
import { formatBytes, getSleapShareBaseUrl } from "@/lib/sleapShare/config";

interface SleapShareAccountCardProps {
  /** Shown in signed-out state. */
  signedOutHint?: string;
  /** Called right after sign-in completes. */
  onSignedIn?: () => void;
  /** Disable actions while an upload/open is in flight. */
  disabled?: boolean;
}

export function SleapShareAccountCard({
  signedOutHint = "Anonymous: up to 100 MB · expires in 7 days. Sign in for 5 GB, private links & 30-day retention.",
  onSignedIn,
  disabled = false,
}: SleapShareAccountCardProps) {
  const credentials = useSleapShareStore((s) => s.credentials);
  const profile = useSleapShareStore((s) => s.profile);
  const authLoading = useSleapShareStore((s) => s.authLoading);
  const hydrateAuth = useSleapShareStore((s) => s.hydrateAuth);
  const setAuthenticated = useSleapShareStore((s) => s.setAuthenticated);
  const signOut = useSleapShareStore((s) => s.signOut);

  const [deviceFlow, setDeviceFlow] = useState<DeviceAuthStartResult | null>(null);
  const [starting, setStarting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    void hydrateAuth();
  }, [hydrateAuth]);

  const stopPolling = useCallback(() => {
    cancelledRef.current = true;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setDeviceFlow(null);
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleStartSignIn = useCallback(async () => {
    if (starting || disabled) return;
    setAuthError(null);
    setStarting(true);
    cancelledRef.current = false;
    const baseUrl = getSleapShareBaseUrl();
    try {
      const started = await startDeviceAuth(baseUrl);
      if (cancelledRef.current) return;
      setDeviceFlow(started);
      void openExternal(started.verificationUrlWithCode);

      let intervalMs = Math.max(2, started.interval) * 1000;
      const deadline = Date.now() + started.expiresIn * 1000;

      const scheduleNext = (delayMs: number) => {
        if (cancelledRef.current) return;
        timerRef.current = setTimeout(async () => {
          if (cancelledRef.current) return;
          if (Date.now() > deadline) {
            stopPolling();
            setAuthError("Sign-in code expired. Click Sign in to try again.");
            return;
          }
          try {
            const res = await pollDeviceAuthOnce(started.deviceCode, baseUrl);
            if (cancelledRef.current) return;
            if (res.status === "success") {
              stopPolling();
              await setAuthenticated({
                token: res.token,
                tokenId: res.tokenId,
                username: res.user.username,
                avatarUrl: res.user.avatar,
                userId: res.user.id,
                baseUrl,
              });
              toast.success(`Signed in to SLEAP Share as @${res.user.username}`);
              onSignedIn?.();
              return;
            }
            if (res.status === "expired") {
              stopPolling();
              setAuthError(res.message || "Sign-in code expired. Please try again.");
              return;
            }
            if (res.status === "slow_down") {
              intervalMs = Math.max(intervalMs + 2000, (res.retryAfter ?? 7) * 1000);
            }
            scheduleNext(intervalMs);
          } catch (err) {
            if (cancelledRef.current) return;
            stopPolling();
            setAuthError(err instanceof Error ? err.message : "Sign-in failed.");
          }
        }, delayMs);
      };

      scheduleNext(intervalMs);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Could not start sign-in.");
    } finally {
      setStarting(false);
    }
  }, [starting, disabled, stopPolling, setAuthenticated, onSignedIn]);

  const handleCopyCode = useCallback(async () => {
    if (!deviceFlow) return;
    try {
      await navigator.clipboard.writeText(deviceFlow.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.info("Copy code manually", { description: deviceFlow.userCode });
    }
  }, [deviceFlow]);

  const handleSignOut = useCallback(async () => {
    if (disabled) return;
    await signOut();
    toast.info("Signed out of SLEAP Share");
  }, [disabled, signOut]);

  if (credentials) {
    const quotaText = profile
      ? profile.quota.unlimited
        ? `${formatBytes(profile.quota.usedBytes)} used · Unlimited`
        : `${formatBytes(profile.quota.usedBytes)} / ${formatBytes(profile.quota.limitBytes)} used`
      : null;

    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <User className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <span className="truncate">@{credentials.username}</span>
              {profile?.isSuperuser && (
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px] gap-0.5">
                  <ShieldCheck className="h-2.5 w-2.5" />
                  Superuser
                </Badge>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {quotaText ?? "Signed in via GitHub"}
            </div>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => void handleSignOut()}
          disabled={disabled}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <LogOut className="h-3 w-3" />
          Sign out
        </Button>
      </div>
    );
  }

  if (deviceFlow) {
    return (
      <div className="space-y-2.5 rounded-lg border border-primary/40 bg-primary/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">
            Finish sign-in on SLEAP Share
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={stopPolling}
            className="text-muted-foreground"
          >
            Cancel
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <code
            className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-center font-mono text-base font-semibold tracking-widest text-foreground select-all"
            data-testid="sleap-share-device-code"
          >
            {deviceFlow.userCode}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleCopyCode()}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            Waiting for GitHub authorization…
          </span>
          <button
            type="button"
            onClick={() => void openExternal(deviceFlow.verificationUrlWithCode)}
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            Open browser
            <ExternalLink className="h-3 w-3" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-muted/25 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">SLEAP Share Account</div>
          <div className="text-[11px] leading-snug text-muted-foreground">
            {signedOutHint}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void handleStartSignIn()}
          disabled={starting || authLoading || disabled}
          className="shrink-0"
        >
          {starting || authLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <LogIn className="h-3 w-3" />
          )}
          Sign in with GitHub
        </Button>
      </div>
      {authError && <p className="text-xs text-destructive">{authError}</p>}
    </div>
  );
}
