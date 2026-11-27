import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import type { ReactElement } from "react";
import { useAppStore } from "@/stores/appStore";
import { toast } from "@/lib/notify";
import { showFirstRunNotice } from "@/lib/analytics/init";

describe("first-run usage data notice", () => {
  const originalInfo = toast.info;
  const originalDismiss = toast.dismiss;
  let capturedOptions: Record<string, unknown> | undefined;
  let capturedTitle: unknown;
  let dismissedIds: Array<string | number | undefined> = [];

  beforeEach(() => {
    capturedOptions = undefined;
    capturedTitle = undefined;
    dismissedIds = [];
    useAppStore.setState({ shareUsageData: null, usageDataNoticeSeen: false });
    toast.info = mock((title: unknown, opts?: Record<string, unknown>) => {
      capturedTitle = title;
      capturedOptions = opts;
      return "usage-data-notice";
    }) as typeof toast.info;
    toast.dismiss = mock((id?: string | number) => {
      dismissedIds.push(id);
      return id ?? "";
    }) as typeof toast.dismiss;
  });

  afterEach(() => {
    cleanup();
    toast.info = originalInfo;
    toast.dismiss = originalDismiss;
  });

  it("offers an orange 'Make SLEAP better' primary button that accepts consent and dismisses", async () => {
    const onSeen = mock(() => {});
    await showFirstRunNotice(onSeen);

    expect(capturedTitle).toBe("Help improve SLEAP");
    expect(capturedOptions?.description).toBeDefined();

    const { getByRole } = render(capturedOptions!.description as ReactElement);
    const acceptBtn = getByRole("button", { name: "Make SLEAP better" });
    expect(acceptBtn.className).toContain("bg-primary");
    expect(acceptBtn.className).toContain("text-primary-foreground");

    fireEvent.click(acceptBtn);

    expect(useAppStore.getState().shareUsageData).toBe(true);
    expect(onSeen).toHaveBeenCalledTimes(1);
    expect(dismissedIds).toEqual(["usage-data-notice"]);
  });

  it("offers a secondary 'Turn off' button that opts out and dismisses", async () => {
    const onSeen = mock(() => {});
    await showFirstRunNotice(onSeen);

    const { getByRole } = render(capturedOptions!.description as ReactElement);
    const optOutBtn = getByRole("button", { name: "Turn off" });
    expect(optOutBtn.className).not.toContain("bg-primary");

    fireEvent.click(optOutBtn);

    expect(useAppStore.getState().shareUsageData).toBe(false);
    expect(onSeen).toHaveBeenCalledTimes(1);
    expect(dismissedIds).toEqual(["usage-data-notice"]);
  });
});
