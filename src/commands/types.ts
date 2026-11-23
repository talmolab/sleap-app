/**
 * Command system types.
 *
 * Ports SLEAP's AppCommand/EditCommand pattern to TypeScript.
 * Each command declares which UpdateTopics it affects, enabling
 * fine-grained UI reactivity.
 */

import type { UpdateTopic } from "../types";
import type { CommandContext } from "./CommandContext";

/** A command that can be executed via the CommandContext. */
export interface Command {
  /** Unique command name for logging and debugging. */
  name: string;

  /** Which data topics this command modifies, used to signal UI updates. */
  topics: UpdateTopic[];

  /** If true, the command manages its own undo snapshot instead of using the default single-frame snapshot. */
  skipAutoSnapshot?: boolean;

  /**
   * Set on a command that changes the labels but signals no topics (the
   * canvas redraws itself), so a View only project still refuses it.
   */
  editsWithoutTopics?: boolean;

  /** Execute the command. Receives the CommandContext for store access. */
  execute(ctx: CommandContext, params?: Record<string, unknown>): Promise<void> | void;
}
