import type { PairedWorker } from "@/stores/connectStore";
import { useConnectStore } from "@/stores/connectStore";
import { confirmDialog, type ConfirmRequest } from "@/stores/confirmStore";

/**
 * The confirm dialog for Forget. Forgetting also unpairs this device on the
 * worker, so getting back in takes a new pairing code — worth a confirm.
 * A worker that already unpaired this device only needs removing locally.
 */
export function forgetWorkerConfirm(worker: Pick<PairedWorker, "label" | "unpairedAt">): ConfirmRequest {
  if (worker.unpairedAt) {
    return {
      title: "Forget worker?",
      message: `Remove ${worker.label} from this app? It already unpaired this device.`,
      confirmLabel: "Forget",
      destructive: true,
    };
  }
  return {
    title: "Forget worker?",
    message:
      `${worker.label} is removed from this app, and this device is unpaired on the worker: ` +
      "to use it again you'll need a new code from 'sleap-rtc pair'.\n\n" +
      "Jobs already on the worker keep running.",
    confirmLabel: "Forget worker",
    destructive: true,
  };
}

/** Forget after the user confirms. Resolves whether it was forgotten. */
export async function forgetWorkerWithConfirm(nodeId: string): Promise<boolean> {
  const { pairedWorkers, forgetWorker } = useConnectStore.getState();
  const worker = pairedWorkers.find((w) => w.nodeId === nodeId);
  if (!worker) return false;
  if (!(await confirmDialog(forgetWorkerConfirm(worker)))) return false;
  await forgetWorker(nodeId);
  return true;
}
