/** Open/close state for Labels ▸ Custom Instance Delete... (kept out of appStore). */
import { create } from "zustand";

export const useCustomDeleteDialog = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>((set) => ({ open: false, setOpen: (open) => set({ open }) }));
