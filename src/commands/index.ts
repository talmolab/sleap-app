/**
 * Command system barrel export.
 *
 * Re-exports all command types, the CommandContext singleton,
 * and all command implementations.
 */

// Core
export type { Command } from "./types";
export { CommandContext, commandContext } from "./CommandContext";
export type { ChangeRecord } from "./CommandContext";

// File commands
export {
  NewProjectCommand,
  OpenProjectCommand,
  SaveProjectCommand,
  SaveAsProjectCommand,
  ExportJsonCommand,
  ExportCSVCommand,
  SaveAsJsonCommand,
  DeletePredictionsByScore,
  DeletePredictionsByRange,
  DeletePredictionsOnLabeledFrames,
  DeletePredictionsByMaxCount,
  ExportPackageCommand,
} from "./fileCommands";

// Navigation commands
export {
  GoNextLabeledFrame,
  GoPrevLabeledFrame,
  GoNextSuggestion,
  GoPrevSuggestion,
  GoToStartFrame,
  GoToEndFrame,
  GoToFrame,
  GoToLastInteracted,
  GoNextUserFrame,
  GoNextTrackSpawnFrame,
} from "./navCommands";

// Edit commands
export {
  AddInstance,
  DeleteSelectedInstance,
  SetPointLocation,
  CopyInstance,
  PasteInstance,
  DeleteFramePredictions,
  DeleteAllPredictions,
  ConvertPredictionToInstance,
  BeginEdit,
  MoveInstance,
  RotateInstance,
} from "./editCommands";

// Track commands
export {
  AddTrack,
  SetInstanceTrack,
  TransposeInstances,
  CopyTrack,
  PasteTrack,
  PropagateTrackLabels,
} from "./trackCommands";

// Skeleton commands
export {
  AddNodeCommand,
  DeleteNodeCommand,
  AddEdgeCommand,
  DeleteEdgeCommand,
  RenameNodeCommand,
  LoadSkeletonTemplateCommand,
  installSkeletonUndoInterceptor,
} from "./skeletonCommands";
