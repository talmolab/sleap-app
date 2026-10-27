/**
 * The success toast shown after an export writes a file (or a folder of
 * files). On desktop it offers "Show in folder" and "Copy path", as PyQt
 * SLEAP's Export Complete dialog offers Open Folder / Copy Path.
 */
import { invoke } from "@tauri-apps/api/core";
import { toast } from "@/lib/notify";
import { sleapCmd } from "@/lib/sleapPlugin";

export function toastExported(
  title: string,
  savedPath: string,
  revealable: boolean
): void {
  toast.success(title, {
    description: savedPath,
    ...(revealable
      ? {
          action: {
            label: "Show in folder",
            onClick: () => {
              void invoke(sleapCmd("reveal_in_file_manager"), { path: savedPath }).catch(
                (e: unknown) =>
                  toast.error("Couldn't show the file", {
                    description: e instanceof Error ? e.message : String(e),
                  })
              );
            },
          },
          cancel: {
            label: "Copy path",
            onClick: () => void navigator.clipboard.writeText(savedPath),
          },
        }
      : {}),
  });
}
