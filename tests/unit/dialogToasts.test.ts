/**
 * A toast raised while a modal dialog is open (e.g. "Configuration files saved"
 * from the Training Configuration window) must be clickable without closing
 * the dialog: `keepOpenOnToastClick` cancels the dialog's outside-interaction
 * dismissal only for clicks inside the toaster.
 */
import { describe, it, expect } from "../bun-test";
import { keepOpenOnToastClick } from "@/lib/dialogToasts";

function outsideEvent(target: EventTarget | null) {
  let prevented = false;
  return {
    event: { target, preventDefault: () => { prevented = true; } },
    prevented: () => prevented,
  };
}

describe("keepOpenOnToastClick", () => {
  it("keeps the dialog open for a click on a toast's button", () => {
    const toaster = document.createElement("section");
    toaster.setAttribute("data-sonner-toaster", "");
    const button = document.createElement("button");
    button.textContent = "Show in folder";
    toaster.appendChild(button);
    document.body.appendChild(toaster);

    const e = outsideEvent(button);
    keepOpenOnToastClick(e.event);
    expect(e.prevented()).toBe(true);
    toaster.remove();
  });

  it("still lets any other outside click close the dialog", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const e = outsideEvent(el);
    keepOpenOnToastClick(e.event);
    expect(e.prevented()).toBe(false);
    el.remove();

    const none = outsideEvent(null);
    keepOpenOnToastClick(none.event);
    expect(none.prevented()).toBe(false);
  });
});
