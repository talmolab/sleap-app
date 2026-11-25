/**
 * Import Videos list, PyQt parity (`importvideos.py`): bulk buttons show for
 * a single staged file, and an HDF5 movie is imported with grayscale left to
 * autodetection (PyQt's HDF5 import has no grayscale parameter).
 */
import { describe, it, expect } from "../bun-test";
import { render, screen, cleanup } from "@testing-library/react";
import {
  VideoImportList,
  importGrayscale,
  type VideoImportEntry,
} from "@/components/dialogs/VideoImportList";

const media: VideoImportEntry = {
  file: new File([], "a.mp4"),
  absPath: null,
  grayscale: false,
};
const movie: VideoImportEntry = {
  file: new File([], "m.h5"),
  absPath: null,
  grayscale: false,
  hdf5: { datasets: ["/box"], dataset: "/box", inputFormat: "channels_first" },
};

describe("VideoImportList bulk buttons", () => {
  // PyQt shows each pair whenever a file of that kind is staged, even one.
  it("shows them for a single file", () => {
    render(<VideoImportList videos={[media]} onChange={() => {}} onRemove={() => {}} />);
    expect(screen.getByRole("button", { name: "All grayscale" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All RGB" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "All channels last" })).toBeNull();
    cleanup();

    render(<VideoImportList videos={[movie]} onChange={() => {}} onRemove={() => {}} />);
    expect(screen.getByRole("button", { name: "All channels last" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All channels first" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "All grayscale" })).toBeNull();
    cleanup();
  });
});

describe("importGrayscale", () => {
  // Forcing RGB on an HDF5 movie (and saving grayscale:false) differed from
  // PyQt, which opens it with grayscale=None (autodetect).
  it("autodetects for an HDF5 movie, uses the checkbox otherwise", () => {
    expect(importGrayscale(movie)).toBeNull();
    expect(importGrayscale({ ...media, grayscale: true })).toBe(true);
    expect(importGrayscale(media)).toBe(false);
  });
});
