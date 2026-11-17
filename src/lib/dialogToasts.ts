/**
 * Pass as a Radix `DialogContent`'s `onInteractOutside` so clicking a toast
 * (its "Show in folder" / "Copy path" buttons) doesn't count as clicking
 * outside the dialog and close it. Pairs with the `[data-sonner-toast]`
 * pointer-events rule in index.css that makes toasts clickable over a modal.
 */
export function keepOpenOnToastClick(e: { target: EventTarget | null; preventDefault(): void }): void {
  const target = e.target as Element | null;
  if (target?.closest?.("[data-sonner-toaster]")) e.preventDefault();
}
