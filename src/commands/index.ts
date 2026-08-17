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
  ImportNwbCommand,
  ImportCocoCommand,
  ImportDlcCommand,
  ImportDlcFolderCommand,
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

// Export Labels Package (embedded-image .pkg.slp) commands
export {
  ExportUserLabelsPackageCommand,
  ExportTrainingPackageCommand,
  ExportFullPackageCommand,
  exportLabelsPackage,
  embedModeForLevel,
  derivePackageFilename,
  frameCountForLevel,
  countUserFrames,
  countTrainingFrames,
  countFullFrames,
} from "./exportPackageCommands";
export type { ExportPackageLevel, EmbedMode } from "./exportPackageCommands";

// Export NWB (ndx-pose) — Labels -> .nwb via the sleap-nn env's sleap-io (desktop)
export {
  ExportNwbCommand,
  deriveNwbFilename,
  tempSlpPathFor,
  hasImageSequenceVideo,
  isSleapNnMissingError,
} from "./exportNwbCommands";

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
  DeleteSelectedInstance,
  SetPointLocation,
  CopyInstance,
  PasteInstance,
  DuplicateInstance,
  DeleteFramePredictions,
  DeleteAllPredictions,
  ConvertPredictionToInstance,
  AddInstancesFromAllPredictions,
  AddInstancesFromAllPredictionsInProject,
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
