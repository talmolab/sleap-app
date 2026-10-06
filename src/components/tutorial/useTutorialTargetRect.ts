import { useEffect, useState } from "react";

export interface TutorialTargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function rectOf(el: Element): TutorialTargetRect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/**
 * Tracks the bounding rect of the first element matching `selector`, or
 * `null` while it isn't in the DOM (e.g. its panel hasn't mounted yet, or was
 * collapsed mid-step). Re-measures on resize/scroll and whenever the DOM
 * changes, so a coachmark stays glued to its target across panel switches —
 * same `getBoundingClientRect`-based idiom as the app's existing hint-bubble
 * popovers (`InferenceConfigDialog`/`TrainingConfigDialog`/`TrainingPanel`),
 * generalized into one hook.
 */
export function useTutorialTargetRect(
  selector: string | null,
): TutorialTargetRect | null {
  const [rect, setRect] = useState<TutorialTargetRect | null>(null);

  useEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }

    let resizeObserver: ResizeObserver | null = null;
    let observedTarget: Element | null = null;

    const measure = () => {
      const target = document.querySelector(selector);
      if (!target) {
        setRect(null);
        if (resizeObserver && observedTarget) {
          resizeObserver.unobserve(observedTarget);
          observedTarget = null;
        }
        return;
      }
      setRect(rectOf(target));
      if (target !== observedTarget) {
        if (resizeObserver && observedTarget) {
          resizeObserver.unobserve(observedTarget);
        }
        resizeObserver?.observe(target);
        observedTarget = target;
      }
    };

    resizeObserver = new ResizeObserver(measure);
    measure();

    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    return () => {
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [selector]);

  return rect;
}
