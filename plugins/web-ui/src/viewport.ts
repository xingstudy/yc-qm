export const PHONE_MAX_WIDTH = 860;

const query = window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`);

export function isPhone(): boolean {
  return query.matches;
}

export function isTouch(): boolean {
  return window.matchMedia("(hover: none)").matches;
}

export function focusTextInputOnDesktop(
  element: HTMLInputElement | HTMLTextAreaElement | null | undefined,
  options?: FocusOptions,
): boolean {
  if (isPhone() || !element) return false;
  element.focus(options);
  return true;
}

const listeners = new Set<(phone: boolean) => void>();
query.addEventListener("change", (e) => {
  for (const fn of listeners) fn(e.matches);
});

export function onPhoneChange(fn: (phone: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
  };
  vv.addEventListener("resize", apply);
  apply();

  const navigator = window.navigator;
  if (
    !isPhone() ||
    (!/iPad|iPhone|iPod/.test(navigator.userAgent) &&
      !(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))
  )
    return;

  let layout: HTMLElement | null = null;
  let previousHeight = "";
  let fullHeight = 0;
  let blurred = false;
  let touchY: number | null = null;
  const unlock = () => {
    if (!layout || !blurred || vv.height < fullHeight - 80) return;
    layout.style.height = previousHeight;
    layout = null;
  };
  document.addEventListener(
    "focusin",
    (event) => {
      if (!(event.target as Element | null)?.matches?.(".composer-input")) return;
      const next = document.querySelector<HTMLElement>(".layout");
      if (!next) return;
      if (layout !== next) {
        if (layout) layout.style.height = previousHeight;
        layout = next;
        previousHeight = next.style.height;
        fullHeight = next.getBoundingClientRect().height;
        next.style.height = `${Math.round(fullHeight)}px`;
      }
      blurred = false;
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (event) => {
      if (!(event.target as Element | null)?.matches?.(".composer-input")) return;
      blurred = true;
      unlock();
    },
    true,
  );
  document.addEventListener(
    "touchstart",
    (event) => {
      touchY = event.touches?.[0]?.clientY ?? null;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (!layout || vv.height >= fullHeight - 80) return;
      const y = event.touches?.[0]?.clientY ?? null;
      const delta = y === null || touchY === null ? 0 : y - touchY;
      touchY = y;
      const scroller = (event.target as Element | null)?.closest<HTMLElement>(".chat-scroll, .composer-input");
      if (
        !scroller ||
        scroller.scrollHeight <= scroller.clientHeight + 1 ||
        (delta < 0 && scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1) ||
        (delta > 0 && scroller.scrollTop <= 1)
      )
        event.preventDefault();
    },
    { passive: false },
  );
  vv.addEventListener("resize", unlock);
}
