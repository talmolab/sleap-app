/**
 * Skeleton panel: displays and edits the current skeleton structure.
 *
 * Shows skeleton name, node/edge counts, node list, edge list,
 * and controls for editing and loading templates.
 *
 * All mutations go through the command system for undo/redo support.
 */

import { useState, useEffect, useRef } from "react";
import { useAppStore } from "../../stores/appStore";
import { commandContext } from "../../commands/CommandContext";
import {
  AddNodeCommand,
  DeleteNodeCommand,
  AddEdgeCommand,
  DeleteEdgeCommand,
  AddSymmetryCommand,
  RemoveSymmetryCommand,
  RenameNodeCommand,
  LoadSkeletonTemplateCommand,
  OpenSkeletonCommand,
  installSkeletonUndoInterceptor,
} from "../../commands/skeletonCommands";
import {
  SKELETON_TEMPLATES,
  TEMPLATE_ORDER,
} from "../../lib/skeletonTemplates";
import {
  parseSkeletonFile,
  compareSkeletons,
  serializeSkeletonYaml,
  type SkeletonDiff,
} from "../../lib/skeletonIO";
import { downloadFile } from "../../lib/exportUtils";
import { getPlatform } from "../../platform/index";
import { toast } from "@/lib/notify";
import type { Skeleton } from "@talmolab/sleap-io.js";
import { ReplaceSkeletonDialog } from "./ReplaceSkeletonDialog";
import {
  validDestinationNames,
  initialEdgeSelection,
  nextEdgeSelection,
  isValidEdgeSelection,
} from "../../lib/skeletonEdgeEditing";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

// Install skeleton undo interceptor once on module load
let interceptorInstalled = false;
function ensureInterceptor() {
  if (!interceptorInstalled) {
    installSkeletonUndoInterceptor(commandContext);
    interceptorInstalled = true;
  }
}

export function SkeletonPanel() {
  const skeleton = useAppStore((s) => s.skeleton);
  // A video (i.e. a frame to draw on) is required to launch the visual builder.
  const video = useAppStore((s) => s.video);
  const [selectedNodeIdx, setSelectedNodeIdx] = useState<number | null>(null);
  const [selectedEdgeIdx, setSelectedEdgeIdx] = useState<number | null>(null);

  // Dialog state for add node
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [newNodeName, setNewNodeName] = useState("");

  // Dialog state for delete node confirmation
  const [deleteNodeOpen, setDeleteNodeOpen] = useState(false);

  // Dialog state for add edge
  const [addEdgeOpen, setAddEdgeOpen] = useState(false);
  const [edgeSrcName, setEdgeSrcName] = useState("");
  const [edgeDstName, setEdgeDstName] = useState("");
  const [selectedSymIdx, setSelectedSymIdx] = useState<number | null>(null);
  const [addSymOpen, setAddSymOpen] = useState(false);
  const [sym1Name, setSym1Name] = useState("");
  const [sym2Name, setSym2Name] = useState("");
  // Sticky seed: remember the last destination we connected to, so reopening
  // the dialog can prefer it as the next source (PyQt-like rapid chaining).
  const lastEdgeDst = useRef<string>("");

  // Dialog state for template confirmation
  const [templateConfirmOpen, setTemplateConfirmOpen] = useState(false);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(
    null
  );

  // State for the "Load From File…" → Replace flow (#163). When the imported
  // skeleton's node set differs from the current one, we stash the parsed
  // skeleton + the node-name diff and open the ReplaceSkeletonDialog so the user
  // can link old nodes to new ones before applying.
  const [replaceDialogOpen, setReplaceDialogOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<{
    newSkeleton: Skeleton;
    diff: SkeletonDiff;
  } | null>(null);

  // Install undo interceptor
  useEffect(() => {
    ensureInterceptor();
  }, []);

  if (!skeleton) {
    return (
      <p className="text-xs text-muted-foreground p-2">No skeleton loaded.</p>
    );
  }

  const nodes = skeleton.nodes ?? [];
  const edges = skeleton.edges ?? [];
  const symmetries = skeleton.symmetries ?? [];
  // Nodes not already part of a symmetry (each node can be in at most one).
  const symmetricNames = new Set(
    symmetries.flatMap((s) => [s.at(0).name, s.at(1).name])
  );
  const freeNodes = nodes.filter((n) => !symmetricNames.has(n.name));

  const addNode = () => {
    if (!newNodeName.trim()) return;
    // Validate no duplicate names
    if (nodes.some((n) => n.name === newNodeName.trim())) return;
    commandContext.execute(AddNodeCommand, { name: newNodeName.trim() });
    setSelectedNodeIdx(nodes.length); // will be the new last index after add
    setNewNodeName("");
    setAddNodeOpen(false);
  };

  const deleteNode = () => {
    if (selectedNodeIdx === null || selectedNodeIdx >= nodes.length) return;
    commandContext.execute(DeleteNodeCommand, { nodeIdx: selectedNodeIdx });
    setSelectedNodeIdx(null);
    setDeleteNodeOpen(false);
  };

  const addEdge = () => {
    if (!isValidEdgeSelection(nodes, edges, edgeSrcName, edgeDstName)) return;
    // Snapshot before executing: AddEdgeCommand mutates skeleton.edges in place,
    // but other skeleton commands reassign it — so capture the pre-add length
    // (the index the new edge will occupy) and build the post-add set explicitly
    // here, rather than relying on `edges` reflecting (or not reflecting) the
    // push.
    const newEdgeIdx = edges.length;
    const postAddEdges = [
      ...edges,
      { source: { name: edgeSrcName }, destination: { name: edgeDstName } },
    ];
    commandContext.execute(AddEdgeCommand, {
      srcName: edgeSrcName,
      dstName: edgeDstName,
    });
    lastEdgeDst.current = edgeDstName;
    const sel = nextEdgeSelection(nodes, postAddEdges, edgeDstName);
    setEdgeSrcName(sel.src);
    setEdgeDstName(sel.dst);
    setSelectedEdgeIdx(newEdgeIdx);
    // NOTE: intentionally do NOT close the dialog — allows rapid edge chaining.
  };

  const addSymmetry = () => {
    if (!sym1Name || !sym2Name || sym1Name === sym2Name) return;
    commandContext.execute(AddSymmetryCommand, {
      node1: sym1Name,
      node2: sym2Name,
    });
    setAddSymOpen(false);
    setSelectedSymIdx(symmetries.length);
  };

  const deleteSymmetry = () => {
    if (selectedSymIdx === null || selectedSymIdx >= symmetries.length) return;
    commandContext.execute(RemoveSymmetryCommand, {
      symmetryIdx: selectedSymIdx,
    });
    setSelectedSymIdx(null);
  };

  const deleteEdge = () => {
    if (selectedEdgeIdx === null || selectedEdgeIdx >= edges.length) return;
    commandContext.execute(DeleteEdgeCommand, { edgeIdx: selectedEdgeIdx });
    setSelectedEdgeIdx(null);
  };

  const handleTemplateSelect = (templateId: string) => {
    if (nodes.length > 0) {
      // Existing skeleton — confirm replacement
      setPendingTemplateId(templateId);
      setTemplateConfirmOpen(true);
    } else {
      commandContext.execute(LoadSkeletonTemplateCommand, { templateId });
    }
  };

  const confirmLoadTemplate = () => {
    if (pendingTemplateId) {
      commandContext.execute(LoadSkeletonTemplateCommand, {
        templateId: pendingTemplateId,
      });
    }
    setPendingTemplateId(null);
    setTemplateConfirmOpen(false);
    setSelectedNodeIdx(null);
    setSelectedEdgeIdx(null);
  };

  const handleRename = (nodeIdx: number, newName: string) => {
    commandContext.execute(RenameNodeCommand, { nodeIdx, newName });
  };

  /** Apply a parsed skeleton to the project (optionally with a rename link map). */
  const applyImport = async (
    newSkeleton: Skeleton,
    linkMap?: Map<string, string>
  ) => {
    await commandContext.execute(OpenSkeletonCommand, { newSkeleton, linkMap });
    setSelectedNodeIdx(null);
    setSelectedEdgeIdx(null);
    toast.success("Loaded skeleton", {
      description: `${newSkeleton.nodes.length} node${
        newSkeleton.nodes.length !== 1 ? "s" : ""
      }`,
    });
  };

  /**
   * Load a skeleton from a .json/.yaml/.yml/.slp file. Seeds a 0-node skeleton
   * directly; on an existing skeleton, applies directly when the node sets match
   * (only edges/symmetries change) else opens the Replace dialog to link nodes.
   */
  const handleLoadFromFile = async () => {
    if (!skeleton) return;
    let picked: string | string[] | File | File[] | null;
    let newSkeleton: Skeleton;
    try {
      const platform = await getPlatform();
      picked = await platform.showOpenDialog({
        filters: [
          { name: "Skeleton", extensions: ["json", "yaml", "yml", "slp"] },
        ],
      });
      if (picked == null) return; // cancelled
      // showOpenDialog may return a single item or an array; take the first.
      const one = Array.isArray(picked) ? picked[0] : picked;
      if (one == null) return; // empty selection

      let filename: string;
      let data: string | ArrayBuffer | Uint8Array;
      if (typeof one === "string") {
        // Tauri: a path string → read bytes via the platform.
        filename = one;
        data = await platform.readFile(one);
      } else {
        // Browser: a File → read text (or bytes for the binary .slp).
        filename = one.name;
        const isSlp = /\.slp$/i.test(one.name);
        data = isSlp ? await one.arrayBuffer() : await one.text();
      }
      newSkeleton = await parseSkeletonFile(filename, data);
    } catch (err) {
      toast.error("Failed to load skeleton", {
        description: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Seed case: an empty (0-node) skeleton → apply directly.
    if (skeleton.nodes.length === 0) {
      await applyImport(newSkeleton);
      return;
    }

    const diff = compareSkeletons(
      skeleton.nodes.map((n) => n.name),
      newSkeleton.nodes.map((n) => n.name)
    );

    // Identical node sets → only edges/symmetries change; apply directly.
    if (diff.addNodes.length === 0 && diff.deleteNodes.length === 0) {
      await applyImport(newSkeleton);
      return;
    }

    // Differing node sets → let the user link old→new nodes first.
    setPendingImport({ newSkeleton, diff });
    setReplaceDialogOpen(true);
  };

  /** Confirm the Replace dialog: apply the import with the chosen link map. */
  const handleReplaceConfirm = async (linkMap: Map<string, string>) => {
    if (pendingImport) {
      await applyImport(pendingImport.newSkeleton, linkMap);
    }
    setPendingImport(null);
    setReplaceDialogOpen(false);
  };

  /** Serialize the current skeleton to YAML and save it (Save As…). */
  const handleSaveAs = async () => {
    if (!skeleton) return;
    try {
      const yaml = serializeSkeletonYaml(skeleton);
      const name = `${skeleton.name || "skeleton"}.yaml`;
      const platform = await getPlatform();

      if (platform.isTauri) {
        const savePath = await platform.showSaveDialog({
          filters: [{ name: "Skeleton YAML", extensions: ["yaml"] }],
          defaultName: name,
        });
        if (!savePath) return; // cancelled
        await platform.writeFile(savePath, new TextEncoder().encode(yaml));
        toast.success("Saved skeleton", { description: savePath });
      } else if ("showSaveFilePicker" in window) {
        // Browser: File System Access API (native save dialog).
        try {
          const handle = await (
            window as unknown as {
              showSaveFilePicker: (
                opts: unknown
              ) => Promise<FileSystemFileHandle>;
            }
          ).showSaveFilePicker({
            types: [
              { description: "Skeleton YAML", accept: { "text/yaml": [".yaml"] } },
            ],
            suggestedName: name,
          });
          const writable = await handle.createWritable();
          await writable.write(new Blob([yaml], { type: "text/yaml" }));
          await writable.close();
          toast.success("Saved skeleton", { description: handle.name });
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          throw err;
        }
      } else {
        // Fallback: anchor download.
        downloadFile(yaml, name, "text/yaml");
        toast.success("Saved skeleton", { description: name });
      }
    } catch (err) {
      toast.error("Failed to save skeleton", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Skeleton info header */}
      <div className="px-2 py-1.5 border-b border-border">
        <div className="text-xs font-medium text-foreground">
          {skeleton.name || "Unnamed skeleton"}
        </div>
        <div className="text-xs text-muted-foreground">
          {nodes.length} node{nodes.length !== 1 ? "s" : ""},{" "}
          {edges.length} edge{edges.length !== 1 ? "s" : ""}
        </div>
      </div>

      {/* Visual skeleton builder launch */}
      <div className="px-2 py-1.5 border-b border-border">
        <Button
          variant="subtle"
          size="xs"
          className="w-full"
          onClick={() => useAppStore.getState().enterSkeletonBuild()}
          disabled={!video}
          title={
            video
              ? "Draw the skeleton directly on the current frame"
              : "Load a video to draw a skeleton"
          }
        >
          Draw skeleton on frame
        </Button>
      </div>

      {/* Template selector + Load/Save buttons */}
      <div className="px-2 py-1.5 border-b border-border">
        <label className="text-xs text-muted-foreground block mb-1">
          Load template
        </label>
        <Select onValueChange={handleTemplateSelect}>
          <SelectTrigger className="w-full h-7 text-xs" size="sm">
            <SelectValue placeholder="Select skeleton template..." />
          </SelectTrigger>
          <SelectContent>
            {TEMPLATE_ORDER.map((id) => {
              const t = SKELETON_TEMPLATES[id];
              return (
                <SelectItem key={id} value={id}>
                  {t.name}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <div className="flex gap-1 mt-1.5">
          <Button
            variant="subtle"
            size="xs"
            className="flex-1"
            onClick={handleLoadFromFile}
          >
            Load From File…
          </Button>
          <Button
            variant="subtle"
            size="xs"
            className="flex-1"
            onClick={handleSaveAs}
            disabled={nodes.length === 0}
          >
            Save As…
          </Button>
        </div>
      </div>

      {/* Tabs for Nodes / Edges */}
      <Tabs defaultValue="nodes" className="flex flex-col flex-1 min-h-0 gap-0">
        <TabsList
          variant="line"
          className="w-full justify-center border-b border-border px-2"
        >
          <TabsTrigger value="nodes" className="text-xs h-7">
            Nodes ({nodes.length})
          </TabsTrigger>
          <TabsTrigger value="edges" className="text-xs h-7">
            Edges ({edges.length})
          </TabsTrigger>
          <TabsTrigger value="symmetries" className="text-xs h-7">
            Symmetries ({symmetries.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="nodes" className="flex flex-col flex-1 min-h-0 mt-0">
          <ScrollArea className="flex-1">
            <NodesTable
              nodes={nodes}
              selectedIdx={selectedNodeIdx}
              onSelect={setSelectedNodeIdx}
              onRename={handleRename}
            />
          </ScrollArea>
          <Separator />
          <div className="flex gap-1 p-2">
            <Button
              variant="subtle"
              size="xs"
              onClick={() => {
                setNewNodeName(`node_${nodes.length}`);
                setAddNodeOpen(true);
              }}
            >
              New Node
            </Button>
            <Button
              variant="subtle"
              size="xs"
              onClick={() => setDeleteNodeOpen(true)}
              disabled={selectedNodeIdx === null}
            >
              Delete Node
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="edges" className="flex flex-col flex-1 min-h-0 mt-0">
          <ScrollArea className="flex-1">
            <EdgesTable
              edges={edges}
              selectedIdx={selectedEdgeIdx}
              onSelect={setSelectedEdgeIdx}
            />
          </ScrollArea>
          <Separator />
          <div className="flex gap-1 p-2">
            <Button
              variant="subtle"
              size="xs"
              onClick={() => {
                const sel = initialEdgeSelection(
                  nodes,
                  edges,
                  lastEdgeDst.current
                );
                setEdgeSrcName(sel.src);
                setEdgeDstName(sel.dst);
                setAddEdgeOpen(true);
              }}
              disabled={nodes.length < 2}
            >
              New Edge
            </Button>
            <Button
              variant="subtle"
              size="xs"
              onClick={deleteEdge}
              disabled={selectedEdgeIdx === null}
            >
              Delete Edge
            </Button>
          </div>
        </TabsContent>

        <TabsContent
          value="symmetries"
          className="flex flex-col flex-1 min-h-0 mt-0"
        >
          <ScrollArea className="flex-1">
            {symmetries.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">
                No symmetries. Pair left/right mirror nodes (e.g. left_ear ↔
                right_ear) so flip augmentation swaps them during training.
              </p>
            ) : (
              <ul className="p-1 text-xs">
                {symmetries.map((s, i) => (
                  <li
                    key={i}
                    onClick={() => setSelectedSymIdx(i)}
                    className={`cursor-pointer rounded px-2 py-1 ${
                      selectedSymIdx === i ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                  >
                    {s.at(0).name} ↔ {s.at(1).name}
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
          <Separator />
          <div className="flex gap-1 p-2">
            <Button
              variant="subtle"
              size="xs"
              onClick={() => {
                setSym1Name(freeNodes[0]?.name ?? "");
                setSym2Name(freeNodes[1]?.name ?? "");
                setAddSymOpen(true);
              }}
              disabled={freeNodes.length < 2}
            >
              New Symmetry
            </Button>
            <Button
              variant="subtle"
              size="xs"
              onClick={deleteSymmetry}
              disabled={selectedSymIdx === null}
            >
              Delete Symmetry
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      {/* Add Node Dialog */}
      <Dialog open={addNodeOpen} onOpenChange={setAddNodeOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Node</DialogTitle>
            <DialogDescription>
              Enter a name for the new skeleton node.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newNodeName}
            onChange={(e) => setNewNodeName(e.target.value)}
            placeholder="Node name"
            onKeyDown={(e) => {
              if (e.key === "Enter") addNode();
            }}
            autoFocus
          />
          {newNodeName.trim() &&
            nodes.some((n) => n.name === newNodeName.trim()) && (
              <p className="text-xs text-destructive">
                A node with this name already exists.
              </p>
            )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddNodeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={addNode}
              disabled={
                !newNodeName.trim() ||
                nodes.some((n) => n.name === newNodeName.trim())
              }
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Node Confirmation Dialog */}
      <Dialog open={deleteNodeOpen} onOpenChange={setDeleteNodeOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Node</DialogTitle>
            <DialogDescription>
              Delete node "
              {selectedNodeIdx !== null && selectedNodeIdx < nodes.length
                ? nodes[selectedNodeIdx].name
                : ""}
              "? This will also remove any edges connected to it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteNodeOpen(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={deleteNode}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Edge Dialog */}
      <Dialog open={addEdgeOpen} onOpenChange={setAddEdgeOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Edge</DialogTitle>
            <DialogDescription>
              Select source and destination nodes for the new edge.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Source
              </label>
              <Select
                value={edgeSrcName}
                onValueChange={(v) => {
                  setEdgeSrcName(v);
                  const valid = validDestinationNames(nodes, v, edges);
                  setEdgeDstName((prev) =>
                    valid.includes(prev) ? prev : (valid[0] ?? "")
                  );
                }}
              >
                <SelectTrigger className="w-full" size="sm">
                  <SelectValue placeholder="Select source node..." />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((n, i) => (
                    <SelectItem key={i} value={n.name}>
                      {n.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Destination
              </label>
              <Select value={edgeDstName} onValueChange={setEdgeDstName}>
                <SelectTrigger className="w-full" size="sm">
                  <SelectValue placeholder="Select destination node..." />
                </SelectTrigger>
                <SelectContent>
                  {validDestinationNames(nodes, edgeSrcName, edges).map(
                    (name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddEdgeOpen(false)}
            >
              Done
            </Button>
            <Button
              size="sm"
              onClick={addEdge}
              disabled={
                !isValidEdgeSelection(nodes, edges, edgeSrcName, edgeDstName)
              }
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Symmetry Dialog */}
      <Dialog open={addSymOpen} onOpenChange={setAddSymOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Symmetry</DialogTitle>
            <DialogDescription>
              Pair two nodes as left/right mirror partners.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Node A
              </label>
              <Select
                value={sym1Name}
                onValueChange={(v) => {
                  setSym1Name(v);
                  setSym2Name((prev) => (prev === v ? "" : prev));
                }}
              >
                <SelectTrigger className="w-full" size="sm">
                  <SelectValue placeholder="Select node..." />
                </SelectTrigger>
                <SelectContent>
                  {freeNodes.map((n, i) => (
                    <SelectItem key={i} value={n.name}>
                      {n.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Node B
              </label>
              <Select value={sym2Name} onValueChange={setSym2Name}>
                <SelectTrigger className="w-full" size="sm">
                  <SelectValue placeholder="Select node..." />
                </SelectTrigger>
                <SelectContent>
                  {freeNodes
                    .filter((n) => n.name !== sym1Name)
                    .map((n, i) => (
                      <SelectItem key={i} value={n.name}>
                        {n.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddSymOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={addSymmetry}
              disabled={!sym1Name || !sym2Name || sym1Name === sym2Name}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Template Confirmation Dialog */}
      <Dialog open={templateConfirmOpen} onOpenChange={setTemplateConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Replace Skeleton?</DialogTitle>
            <DialogDescription>
              The current skeleton has {nodes.length} node
              {nodes.length !== 1 ? "s" : ""}. Loading a template will replace
              all nodes and edges. All existing instance points will be reset.
              This action can be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPendingTemplateId(null);
                setTemplateConfirmOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={confirmLoadTemplate}
            >
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replace Skeleton Dialog (Load From File… with a differing node set) */}
      {pendingImport && (
        <ReplaceSkeletonDialog
          open={replaceDialogOpen}
          onOpenChange={(open) => {
            setReplaceDialogOpen(open);
            if (!open) setPendingImport(null);
          }}
          diff={pendingImport.diff}
          newSkeletonName={pendingImport.newSkeleton.name}
          onConfirm={handleReplaceConfirm}
        />
      )}
    </div>
  );
}

function NodesTable({
  nodes,
  selectedIdx,
  onSelect,
  onRename,
}: {
  nodes: { name: string }[];
  selectedIdx: number | null;
  onSelect: (idx: number | null) => void;
  onRename: (nodeIdx: number, newName: string) => void;
}) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editingIdx !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingIdx]);

  if (nodes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground p-2">No nodes defined.</p>
    );
  }

  const startEditing = (idx: number) => {
    setEditingIdx(idx);
    setEditValue(nodes[idx].name);
  };

  const commitEdit = () => {
    if (editingIdx === null) return;
    const trimmed = editValue.trim();

    // Validate: not empty, not duplicate (unless same node)
    if (
      trimmed &&
      !nodes.some((n, i) => n.name === trimmed && i !== editingIdx)
    ) {
      if (trimmed !== nodes[editingIdx].name) {
        onRename(editingIdx, trimmed);
      }
    }
    setEditingIdx(null);
  };

  const cancelEdit = () => {
    setEditingIdx(null);
  };

  const isDuplicate =
    editingIdx !== null &&
    editValue.trim() !== "" &&
    nodes.some((n, i) => n.name === editValue.trim() && i !== editingIdx);

  return (
    <Table>
      <TableHeader>
        <TableRow className="border-b hover:bg-transparent">
          <TableHead className="py-1 px-2 text-xs font-normal h-auto">
            #
          </TableHead>
          <TableHead className="py-1 px-2 text-xs font-normal h-auto">
            Name
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {nodes.map((node, i) => (
          <TableRow
            key={i}
            onClick={() => onSelect(selectedIdx === i ? null : i)}
            className={cn(
              "cursor-pointer border-b-0",
              selectedIdx === i
                ? "bg-orange-500/10 border-l-2 border-l-orange-500 text-foreground"
                : "hover:bg-muted/50 text-foreground"
            )}
          >
            <TableCell className="py-0.5 px-2 text-xs text-muted-foreground">
              {i}
            </TableCell>
            <TableCell
              className="py-0.5 px-2 text-xs"
              onDoubleClick={(e) => {
                e.stopPropagation();
                startEditing(i);
              }}
            >
              {editingIdx === i ? (
                <div>
                  <input
                    ref={inputRef}
                    className={cn(
                      "w-full bg-transparent border-b outline-none text-xs py-0",
                      isDuplicate
                        ? "border-destructive text-destructive"
                        : "border-primary"
                    )}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit();
                      }
                      e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {isDuplicate && (
                    <span className="text-[10px] text-destructive">
                      Duplicate name
                    </span>
                  )}
                </div>
              ) : (
                node.name
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function EdgesTable({
  edges,
  selectedIdx,
  onSelect,
}: {
  edges: { source: { name: string }; destination: { name: string } }[];
  selectedIdx: number | null;
  onSelect: (idx: number | null) => void;
}) {
  if (edges.length === 0) {
    return (
      <p className="text-xs text-muted-foreground p-2">No edges defined.</p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="border-b hover:bg-transparent">
          <TableHead className="py-1 px-2 text-xs font-normal h-auto">
            #
          </TableHead>
          <TableHead className="py-1 px-2 text-xs font-normal h-auto">
            Source
          </TableHead>
          <TableHead className="py-1 px-2 text-xs font-normal h-auto" />
          <TableHead className="py-1 px-2 text-xs font-normal h-auto">
            Destination
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {edges.map((edge, i) => (
          <TableRow
            key={i}
            onClick={() => onSelect(selectedIdx === i ? null : i)}
            className={cn(
              "cursor-pointer border-b-0",
              selectedIdx === i
                ? "bg-orange-500/10 border-l-2 border-l-orange-500 text-foreground"
                : "hover:bg-muted/50 text-foreground"
            )}
          >
            <TableCell className="py-0.5 px-2 text-xs text-muted-foreground">
              {i}
            </TableCell>
            <TableCell className="py-0.5 px-2 text-xs">
              {edge.source.name}
            </TableCell>
            <TableCell className="py-0.5 px-1 text-xs text-muted-foreground">
              &rarr;
            </TableCell>
            <TableCell className="py-0.5 px-2 text-xs">
              {edge.destination.name}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
