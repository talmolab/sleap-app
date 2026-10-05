/**
 * RemoteFileBrowser: the worker-filesystem browser used by TrainingPanel,
 * InferencePanel, PathResolutionDialog, RemoteDataSummary ("Locate on
 * worker…"), and the launcher wizard (NewJobWizard, mocked in its own test).
 *
 * Fix: this used to be a hand-rolled `fixed inset-0 z-50` div rendered IN
 * PLACE rather than portaled, so it opened hidden behind any real Radix
 * Dialog that opened it (that dialog's own portal mounts to `document.body`
 * later in the DOM, at the same z-index, and also blocks pointer events
 * outside its own content). It's now the app's shadcn `Dialog`, so it
 * portals to `document.body` like any other nested Radix dialog and stacks
 * above whatever opened it. These tests cover that portal/close contract
 * plus the browse/select behavior any caller relies on; per-worker browsing
 * (`workerId` -> `browseRemoteDirOn`) and the mount picker are PR5b.1's own
 * prior behavior, re-asserted here now that the wrapper changed.
 */
import { describe, it, expect, afterEach, beforeEach } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useConnectStore } from "@/stores/connectStore";
import type { FileEntry } from "@/lib/sleapConnect";
import { RemoteFileBrowser } from "@/components/dialogs/RemoteFileBrowser";

function entries(...names: Array<{ name: string; isDir: boolean }>): FileEntry[] {
  return names;
}

beforeEach(() => {
  useConnectStore.setState({
    browseRemoteDir: async () => entries({ name: "a.mp4", isDir: false }),
    browseRemoteDirOn: async () => entries({ name: "a.mp4", isDir: false }),
  });
});

afterEach(() => {
  cleanup();
});

describe("RemoteFileBrowser — open/close", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <RemoteFileBrowser open={false} onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Browse Worker Filesystem")).toBeNull();
  });

  it("portals its content onto document.body when open", async () => {
    const { container } = render(
      <RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} />,
    );
    // Nothing renders inline where the component is mounted — it portals out.
    expect(container.firstChild).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Browse Worker Filesystem" })).toBeInTheDocument(),
    );
    expect(document.body.contains(screen.getByRole("dialog"))).toBe(true);
  });

  it("Escape calls onClose and nothing else", async () => {
    let closeCalls = 0;
    const onSelect = () => {
      throw new Error("onSelect should not be called on Escape");
    };
    render(<RemoteFileBrowser open onClose={() => closeCalls++} onSelect={onSelect} mounts={["/mnt/data"]} />);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(closeCalls).toBe(1));
  });

  it("the dialog's own close button calls onClose", async () => {
    let closeCalls = 0;
    render(<RemoteFileBrowser open onClose={() => closeCalls++} onSelect={() => {}} mounts={["/mnt/data"]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(closeCalls).toBe(1));
  });

  it("Cancel calls onClose without selecting", async () => {
    let closeCalls = 0;
    const onSelect = () => {
      throw new Error("onSelect should not be called on Cancel");
    };
    render(<RemoteFileBrowser open onClose={() => closeCalls++} onSelect={onSelect} mounts={["/mnt/data"]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closeCalls).toBe(1);
  });
});

describe("RemoteFileBrowser — browsing + selection", () => {
  it("directory mode: Select Folder selects the current directory and closes", async () => {
    let selected: string | null = null;
    let closed = false;
    render(
      <RemoteFileBrowser
        open
        onClose={() => {
          closed = true;
        }}
        onSelect={(p) => {
          selected = p;
        }}
        mounts={["/mnt/data"]}
        mode="directory"
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Select Folder" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Select Folder" }));
    expect(selected).toBe("/mnt/data");
    expect(closed).toBe(true);
  });

  it("file mode: Select File is disabled until a file is picked, then selects + closes", async () => {
    let selected: string | null = null;
    render(
      <RemoteFileBrowser
        open
        onClose={() => {}}
        onSelect={(p) => {
          selected = p;
        }}
        mounts={["/mnt/data"]}
        mode="file"
      />,
    );
    await waitFor(() => expect(screen.getByText("a.mp4")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Select File" })).toBeDisabled();

    fireEvent.click(screen.getByText("a.mp4"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Select File" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Select File" }));
    expect(selected).toBe("/mnt/data/a.mp4");
  });

  it("filters file-mode entries by fileFilter, case-insensitively", async () => {
    useConnectStore.setState({
      browseRemoteDir: async () =>
        entries({ name: "a.MP4", isDir: false }, { name: "b.txt", isDir: false }),
    });
    render(
      <RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} mode="file" fileFilter=".mp4" />,
    );
    await waitFor(() => expect(screen.getByText("a.MP4")).toBeInTheDocument());
    expect(screen.queryByText("b.txt")).toBeNull();
  });

  it("a single mount browses it directly instead of showing the mount picker", async () => {
    let browsedPath: string | null = null;
    useConnectStore.setState({
      browseRemoteDir: async (path: string) => {
        browsedPath = path;
        return entries();
      },
    });
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} />);
    await waitFor(() => expect(browsedPath).toBe("/mnt/data"));
    expect(screen.queryByText("No mounts available on this worker")).toBeNull();
  });

  it("zero mounts shows the mount picker's empty state instead of browsing", async () => {
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={[]} />);
    await waitFor(() =>
      expect(screen.getByText("No mounts available on this worker")).toBeInTheDocument(),
    );
  });

  it("multiple mounts show the mount picker; opening one browses it", async () => {
    let browsedPath: string | null = null;
    useConnectStore.setState({
      browseRemoteDir: async (path: string) => {
        browsedPath = path;
        return entries();
      },
    });
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/a", "/mnt/b"]} />);
    await waitFor(() => expect(screen.getByText("/mnt/a")).toBeInTheDocument());
    expect(screen.getByText("/mnt/b")).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText("/mnt/a"));
    await waitFor(() => expect(browsedPath).toBe("/mnt/a"));
  });

  it("a given workerId browses that worker (browseRemoteDirOn), not the selected one", async () => {
    let calledWith: [string, string] | null = null;
    useConnectStore.setState({
      browseRemoteDirOn: async (workerId: string, path: string) => {
        calledWith = [workerId, path];
        return entries();
      },
      browseRemoteDir: async () => {
        throw new Error("should not call browseRemoteDir when workerId is given");
      },
    });
    render(
      <RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} workerId="node-a" />,
    );
    await waitFor(() => expect(calledWith).toEqual(["node-a", "/mnt/data"]));
  });
});
