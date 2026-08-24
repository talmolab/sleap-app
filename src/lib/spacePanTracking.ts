/**
 * Cross-cutting flag distinguishing a plain tap of Space (which should still
 * jump to the next/prev suggestion, per legacy SLEAP) from a
 * hold-Space-then-drag pan gesture (which should not also jump frames).
 *
 * Space triggers two independent, unrelated behaviors in this app: the
 * global "goto next/prev suggestion" shortcut (useKeyboardShortcuts.ts) and
 * VideoPlayer's temporary hold-to-pan mode. Both listen to the same physical
 * key, so without this flag, merely pressing Space to start a pan-drag would
 * also immediately jump to the next suggestion frame out from under the drag.
 *
 * VideoPlayer.tsx sets this when a mouse-drag starts while Space is held;
 * useKeyboardShortcuts.ts's Space-release handler reads and resets it to
 * decide whether the suggestion jump should actually fire.
 */
export const spacePanState = { draggedWhileHeld: false };
