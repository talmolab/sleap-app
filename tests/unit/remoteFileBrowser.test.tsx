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
 * plus the browse/select behavior any caller relies on: per-worker browsing
 * (`workerId` -> `browseRemoteDirOn`), the Finder-style sidebar, views,
 * search, greyed-out non-matching files, Favorites/Recents, and look-only
 * `browse` mode. Pure sorting/path logic is in remoteBrowser.test.ts.
 */
import { describe, it, expect, afterEach, beforeEach } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { useConnectStore } from "@/stores/connectStore";
import { useRemoteBrowserStore } from "@/stores/remoteBrowserStore";
import type { FileEntry } from "@/lib/sleapConnect";
import { DEFAULT_SORT } from "@/lib/remoteBrowser";
import { RemoteFileBrowser, mountRootFor } from "@/components/dialogs/RemoteFileBrowser";

function entries(...names: Array<{ name: string; isDir: boolean }>): FileEntry[] {
  return names;
}

beforeEach(() => {
  useRemoteBrowserStore.setState({ view: "list", sort: DEFAULT_SORT, size: null, favorites: {}, recents: {} });
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
    expect(screen.queryByText("Browse Worker Files")).toBeNull();
  });

  it("portals its content onto document.body when open", async () => {
    const { container } = render(
      <RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} />,
    );
    // Nothing renders inline where the component is mounted — it portals out.
    expect(container.firstChild).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Browse Worker Files" })).toBeInTheDocument(),
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

  it("browse mode is look-only: Close instead of Cancel/Open", async () => {
    let closeCalls = 0;
    render(<RemoteFileBrowser open onClose={() => closeCalls++} mounts={["/mnt/data"]} mode="browse" />);
    await waitFor(() => expect(screen.getByText("a.mp4")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(closeCalls).toBe(1);
  });
});

describe("RemoteFileBrowser — browsing + selection", () => {
  it("directory mode: Choose Folder picks the current folder and closes", async () => {
    // Tracked via arrays, not a single reassigned `let` — a `let x = null`
    // read back in the SAME scope keeps TS's control-flow type narrowed to
    // `null` even after a `fireEvent.click` that runs the closures.
    const selected: string[] = [];
    const closeCalls: number[] = [];
    render(
      <RemoteFileBrowser
        open
        onClose={() => closeCalls.push(1)}
        onSelect={(p) => selected.push(p)}
        mounts={["/mnt/data"]}
        mode="directory"
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose Folder" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Choose Folder" }));
    expect(selected).toEqual(["/mnt/data"]);
    expect(closeCalls).toHaveLength(1);
  });

  it("file mode: Open is disabled until a file is picked, then picks it, closes, and adds it to Recents", async () => {
    const selected: string[] = [];
    render(
      <RemoteFileBrowser open onClose={() => {}} onSelect={(p) => selected.push(p)} mounts={["/mnt/data"]} mode="file" />,
    );
    await waitFor(() => expect(screen.getByText("a.mp4")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();

    fireEvent.click(screen.getByText("a.mp4"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(selected).toEqual(["/mnt/data/a.mp4"]);
    expect(useRemoteBrowserStore.getState().recents[""]?.map((r) => r.path)).toEqual(["/mnt/data/a.mp4"]);
  });

  it("double-clicking a matching file picks it straight away", async () => {
    const selected: string[] = [];
    render(
      <RemoteFileBrowser open onClose={() => {}} onSelect={(p) => selected.push(p)} mounts={["/mnt/data"]} mode="file" />,
    );
    await waitFor(() => expect(screen.getByText("a.mp4")).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByText("a.mp4"));
    expect(selected).toEqual(["/mnt/data/a.mp4"]);
  });

  it("files outside fileFilter still show, greyed out and unselectable", async () => {
    useConnectStore.setState({
      browseRemoteDir: async () => entries({ name: "a.MP4", isDir: false }, { name: "b.txt", isDir: false }),
    });
    render(
      <RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} mode="file" fileFilter=".mp4" />,
    );
    await waitFor(() => expect(screen.getByText("b.txt")).toBeInTheDocument());
    const other = screen.getByText("b.txt").closest("[role=option]")!;
    expect(other).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(other);
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
    expect(screen.getByText("a.MP4").closest("[role=option]")).toHaveAttribute("aria-disabled", "false");
  });

  it("search filters the current folder by name", async () => {
    useConnectStore.setState({
      browseRemoteDir: async () => entries({ name: "flies.slp", isDir: false }, { name: "mice.slp", isDir: false }),
    });
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} mode="file" />);
    await waitFor(() => expect(screen.getByText("mice.slp")).toBeInTheDocument());
    fireEvent.change(screen.getByRole("textbox", { name: "Search this folder" }), { target: { value: "FLI" } });
    expect(screen.getByText("flies.slp")).toBeInTheDocument();
    expect(screen.queryByText("mice.slp")).toBeNull();
  });

  it("opens at the first mount, lists every mount under Locations, and switches between them", async () => {
    const browsed: string[] = [];
    useConnectStore.setState({
      browseRemoteDir: async (path: string) => {
        browsed.push(path);
        return entries();
      },
    });
    render(
      <RemoteFileBrowser
        open
        onClose={() => {}}
        onSelect={() => {}}
        mounts={["/mnt/a", "/mnt/b"]}
        mountLabels={{ "/mnt/b": "Scratch" }}
      />,
    );
    await waitFor(() => expect(browsed).toEqual(["/mnt/a"]));
    const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
    fireEvent.click(within(sidebar).getByText("Scratch"));
    await waitFor(() => expect(browsed).toEqual(["/mnt/a", "/mnt/b"]));
  });

  it("zero mounts shows an empty state instead of browsing", async () => {
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={[]} />);
    await waitFor(() => expect(screen.getByText(/isn.t sharing any folders/)).toBeInTheDocument());
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
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} workerId="node-a" />);
    await waitFor(() => expect(calledWith).toEqual(["node-a", "/mnt/data"]));
  });

  it("the star pins the current folder to Favorites for this worker", async () => {
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} workerId="fav-worker" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to Favorites" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Add to Favorites" }));
    expect(useRemoteBrowserStore.getState().favorites["fav-worker"]).toEqual(["/mnt/data"]);
    expect(within(screen.getByRole("navigation", { name: "Sidebar" })).getByText("Favorites")).toBeInTheDocument();
  });

  it("the view switch changes the shared view setting", async () => {
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} />);
    await waitFor(() => expect(screen.getByText("a.mp4")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "View as Columns" }));
    expect(useRemoteBrowserStore.getState().view).toBe("columns");
    fireEvent.click(screen.getByRole("button", { name: "View as Icons" }));
    expect(useRemoteBrowserStore.getState().view).toBe("icons");
    expect(screen.getByText("a.mp4")).toBeInTheDocument();
  });
});

describe("RemoteFileBrowser — big folders, long names, missing folders", () => {
  const many = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ name: `f${String(from + i).padStart(4, "0")}.png`, isDir: false }));

  it("loads a big folder a batch at a time, and the rest once a search needs the whole folder", async () => {
    const calls: Array<[number | undefined, number | undefined]> = [];
    useConnectStore.setState({
      browseRemoteDir: async (_path: string, offset?: number, limit?: number) => {
        calls.push([offset, limit]);
        return (offset ?? 0) === 0 ? many(100) : many(30, 100);
      },
    });
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} mode="file" />);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(100));
    expect(calls).toEqual([[0, 100]]);
    expect(screen.getByText(/Loading more/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search this folder" }), { target: { value: "f01" } });
    await waitFor(() => expect(calls).toEqual([[0, 100], [100, 100]]));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(30)); // f0100–f0129
    expect(screen.queryByText(/Loading more/)).toBeNull();
  });

  it("a folder that can't be opened falls back to its nearest parent, with a notice", async () => {
    useRemoteBrowserStore.setState({
      recents: { "": [{ path: "/mnt/data/gone/deeper", isDir: true, openedAt: 1 }] },
    });
    useConnectStore.setState({
      browseRemoteDir: async (path: string) => {
        if (path.startsWith("/mnt/data/gone")) throw new Error(`Path does not exist: ${path}`);
        return entries({ name: "here.slp", isDir: false });
      },
    });
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} />);
    await waitFor(() => expect(screen.getByText("here.slp")).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("navigation", { name: "Sidebar" })).getByText("deeper"));
    await waitFor(() => expect(screen.getByText(/“deeper” couldn’t be opened/)).toBeInTheDocument());
    expect(screen.getByText("here.slp")).toBeInTheDocument();
  });

  it("long names keep their ending, with the full name on hover", async () => {
    const long = "2026-10-20_courtship_assay_arena_B_session_0042_proofread.v003.slp";
    useConnectStore.setState({ browseRemoteDir: async () => entries({ name: long, isDir: false }) });
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} />);
    const name = await screen.findByTitle(long);
    expect(name.lastElementChild?.textContent).toBe("ead.v003.slp"); // the part that never shrinks
    expect(screen.getByText(long)).toHaveClass("sr-only"); // whole name for screen readers
  });
});

describe("RemoteFileBrowser — stays inside the worker's mounts", () => {
  it("mountRootFor picks the longest mount containing a path, else null", () => {
    expect(mountRootFor("/root/vast/amick/data", ["/root/vast/amick"])).toBe("/root/vast/amick");
    expect(mountRootFor("/root/vast/amick", ["/root/vast/amick/"])).toBe("/root/vast/amick");
    expect(mountRootFor("/root/vast", ["/root/vast/amick"])).toBeNull();
    expect(mountRootFor("/root/vast/amickx", ["/root/vast/amick"])).toBeNull();
    expect(mountRootFor("/a/b/c", ["/a", "/a/b"])).toBe("/a/b");
  });

  it("breadcrumbs start at the mount root; Back returns to the previous folder", async () => {
    const browsed: string[] = [];
    useConnectStore.setState({
      browseRemoteDirOn: async (_workerId: string, path: string) => {
        browsed.push(path);
        return path === "/root/vast/amick" ? entries({ name: "sub", isDir: true }) : entries({ name: "inner.slp", isDir: false });
      },
    });
    render(
      <RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/root/vast/amick"]} workerId="mount-crumbs-worker" />,
    );
    await waitFor(() => expect(screen.getByText("sub")).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByText("sub"));
    await waitFor(() => expect(screen.getByText("inner.slp")).toBeInTheDocument());
    expect(browsed).toEqual(["/root/vast/amick", "/root/vast/amick/sub"]);

    // The mount root is one crumb; "root"/"vast" above it aren't offered.
    expect(screen.queryByText("root")).toBeNull();
    expect(screen.queryByText("vast")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByText("sub")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Forward" })).not.toBeDisabled();
  });

  it("Go to Folder refuses a path outside the mounts", async () => {
    render(<RemoteFileBrowser open onClose={() => {}} onSelect={() => {}} mounts={["/mnt/data"]} />);
    await waitFor(() => expect(screen.getByText("a.mp4")).toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "g", metaKey: true, shiftKey: true });
    const input = await screen.findByRole("textbox", { name: "Go to folder" });
    fireEvent.change(input, { target: { value: "/etc" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText(/isn.t inside one of this worker.s shared folders/)).toBeInTheDocument();
  });
});
