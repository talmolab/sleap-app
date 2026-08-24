/**
 * Core types for SLEAP Label Web.
 * Re-exports from @talmolab/sleap-io.js and defines app-specific types.
 */

// Re-export data model types from sleap-io.js
export type {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Node,
  Edge,
  Track,
  Video,
  SuggestionFrame,
} from "@talmolab/sleap-io.js";

/** Update topics emitted by commands to signal what changed. */
export enum UpdateTopic {
  Labels = "labels",
  Frame = "frame",
  Skeleton = "skeleton",
  Tracks = "tracks",
  Suggestions = "suggestions",
  Video = "video",
  Instance = "instance",
  View = "view",
  Project = "project",
}

/** Edge rendering style. */
export type EdgeStyle = "Line" | "Wedge";

/** Color application target. "auto" resolves to "track" once any instance
 * has an assigned track, otherwise "node" — see resolveColorTarget(). */
export type ColorTarget = "instance" | "track" | "node" | "edge" | "auto";

/** Instance placement method when adding new instances. */
export type InstancePlacementMethod =
  | "best"
  | "template"
  | "force_directed"
  | "random"
  | "prior_frame"
  | "prediction";

/** Point coordinates for canvas rendering. */
export interface CanvasPoint {
  x: number;
  y: number;
  visible: boolean;
  complete: boolean;
  score?: number;
  name?: string;
}

/** A rendered instance with computed canvas data. */
export interface RenderableInstance {
  instanceIndex: number;
  points: CanvasPoint[];
  edges: [number, number][];
  color: [number, number, number];
  isSelected: boolean;
  isPredicted: boolean;
  trackName: string | null;
  score?: number;
}

/** Seekbar mark types matching the Qt slider. */
export type SeekbarMarkType =
  | "simple"
  | "simple_thin"
  | "filled"
  | "open"
  | "predicted"
  | "tick"
  | "tick_column"
  | "track";

export interface SeekbarMark {
  type: SeekbarMarkType;
  val: number;
  endVal?: number;
  row?: number;
  color: string | [number, number, number];
}
