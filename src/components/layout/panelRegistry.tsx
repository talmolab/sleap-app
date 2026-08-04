/**
 * Right-sidebar panel registry: maps each panel id to its label, icon, and
 * content component.
 *
 * Extracted from AppShell so both `AppShell` (renders the strip) and `MenuBar`
 * (the "Panels" visibility menu, #135) can import it without an import cycle.
 * The id list / default order lives separately in `@/lib/panelLayout` as a
 * dependency-free source of truth; a test asserts these two stay in sync.
 */

import {
  Film,
  Bone,
  Users,
  Lightbulb,
  Bug,
  Eye,
  Bell,
  Cpu,
  Zap,
  Globe,
  GraduationCap,
  TableProperties,
  Workflow,
  ScanEye,
} from "lucide-react";

import { VideosPanel } from "../panels/VideosPanel";
import { SkeletonPanel } from "../panels/SkeletonPanel";
import { InstancesPanel } from "../panels/InstancesPanel";
import { SuggestionsPanel } from "../panels/SuggestionsPanel";
import { ViewPanel } from "../panels/ViewPanel";
import { DebugPanel } from "../panels/DebugPanel";
import { NotificationsPanel } from "../panels/NotificationsPanel";
import { EnvironmentPanel } from "../panels/EnvironmentPanel";
import { InferencePanel } from "../panels/InferencePanel";
import { ConnectPanel } from "../panels/ConnectPanel";
import { FramesPanel } from "../panels/FramesPanel";
import { TrainingPanel } from "../panels/TrainingPanel";
import { ActiveLearningPanel } from "../panels/ActiveLearningPanel";
import { CorrectionPanel } from "../panels/CorrectionPanel";

/** Panel definitions with icons. Render order comes from the store's panelOrder. */
export const PANELS = [
  { id: "videos", label: "Videos", icon: Film, component: VideosPanel },
  { id: "skeleton", label: "Skeleton", icon: Bone, component: SkeletonPanel },
  { id: "instances", label: "Instances", icon: Users, component: InstancesPanel },
  { id: "view", label: "View", icon: Eye, component: ViewPanel },
  { id: "suggestions", label: "Suggestions", icon: Lightbulb, component: SuggestionsPanel },
  { id: "frames", label: "Frames", icon: TableProperties, component: FramesPanel },
  { id: "inference", label: "Inference", icon: Zap, component: InferencePanel },
  { id: "training", label: "Training", icon: GraduationCap, component: TrainingPanel },
  { id: "active-learning", label: "Active Learning", icon: Workflow, component: ActiveLearningPanel },
  // Same component as the Active-Learning "Correct" tab, deliberately mounted
  // twice: the loop user reaches it in sequence, someone correcting a
  // predictions.slp reaches it directly. It holds only local filter state and
  // runs no effects, so two mount points don't interact.
  { id: "correct", label: "Correct", icon: ScanEye, component: CorrectionPanel },
  { id: "environment", label: "Environment", icon: Cpu, component: EnvironmentPanel },
  { id: "notifications", label: "Notifications", icon: Bell, component: NotificationsPanel },
  { id: "debug", label: "Debug", icon: Bug, component: DebugPanel },
  { id: "connect", label: "Connect", icon: Globe, component: ConnectPanel },
] as const;

export type PanelDescriptor = (typeof PANELS)[number];
