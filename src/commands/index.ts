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
  ImportAnalysisH5Command,
  SaveProjectCommand,
  SaveAsProjectCommand,
  ExportJsonCommand,
  ExportCSVCommand,
  ExportAnalysisH5Command,
  SaveAsJsonCommand,
  DeletePredictionsByScore,
  DeletePredictionsByRange,
  DeletePredictionsOnLabeledFrames,
  DeletePredictionsByMaxCount,
  DeletePredictionsByArea,
  DeletePredictionsByTrack,
  DeleteInstancesByType,
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
  SelectToFrame,
} from "./navCommands";

// Edit commands
export {
  AddInstance,
  SeedCentroid,
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
  DeleteInstanceAndTrack,
  DeleteTrack,
  DeleteUnusedTracks,
  DeleteAllTracks,
} from "./trackCommands";

// Skeleton commands
export {
  AddNodeCommand,
  DeleteNodeCommand,
  AddEdgeCommand,
  DeleteEdgeCommand,
  RenameNodeCommand,
  LoadSkeletonTemplateCommand,
  OpenSkeletonCommand,
  installSkeletonUndoInterceptor,
} from "./skeletonCommands";
