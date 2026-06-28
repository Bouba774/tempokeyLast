/**
 * Centralized Android hardware back-button manager.
 *
 * Goals:
 *  - One single `App.backButton` listener for the whole app (no duplicates).
 *  - LIFO stack of handlers registered by components via `useBackHandler`.
 *  - Built-in fallbacks that mimic a native Android app:
 *      1. If the soft keyboard is visible -> hide it.
 *      2. If a Radix overlay is open (dialog/sheet/menu/popover) -> dispatch
 *         Escape so Radix closes it (single source of truth, no per-component
 *         wrapping needed).
 *      3. If the router can navigate back -> history.back().
 *      4. On the root route -> "press back again to quit" toast within 2s,
 *         then `App.exitApp()`.
 *
 * Web preview is a no-op (Capacitor.isNativePlatform() === false).
 */
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Keyboard } from "@capacitor/keyboard";
import { toast } from "sonner";

export type BackHandler = () => boolean | void | Promise<boolean | void>;

const stack: BackHandler[] = [];
let initialised = false;
let handlingBack = false;

export function pushBackHandler(handler: BackHandler): () => void {
  stack.push(handler);
  return () => {
    const i = stack.lastIndexOf(handler);
    if (i >= 0) stack.splice(i, 1);
  };
}

function hasOpenRadixOverlay(): boolean {
  // Radix sets data-state="open" on Dialog/Sheet/AlertDialog/DropdownMenu/
  // Popover/Select/Tooltip content nodes. We only react to interactive ones.
  const selectors = [
    '[role="dialog"][data-state="open"]',
    '[role="alertdialog"][data-state="open"]',
    '[role="menu"][data-state="open"]',
    '[role="listbox"][data-state="open"]',
    '[data-radix-popper-content-wrapper] [data-state="open"]',
  ];
  return !!document.querySelector(selectors.join(","));
}

function dispatchEscape() {
  const ev = new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    keyCode: 27,
    which: 27,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(ev);
}

function logicalPathname(): string {
  if (typeof window === "undefined") return "/";
  const hash = window.location.hash;
  if (hash.startsWith("#/")) return hash.slice(1).split(/[?#]/, 1)[0] || "/";
  return window.location.pathname || "/";
}

function isRootRoute(): boolean {
  const path = logicalPathname();
  return path === "/" || path === "" || path === "/index.html";
}

function isEditableElement(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

function blurEditableAndHideKeyboard(): boolean {
  const active = document.activeElement;
  if (!isEditableElement(active)) return false;
  try {
    (active as HTMLElement).blur();
  } catch {
    /* ignore */
  }
  void Keyboard.hide().catch(() => {});
  return true;
}

async function leaveAppFromRoot(): Promise<void> {
  try {
    await App.minimizeApp();
    return;
  } catch {
    /* fallback below */
  }
  try {
    await App.exitApp();
  } catch {
    toast("Retour Android indisponible", { duration: 1600 });
  }
}

async function defaultBack(canGoBack: boolean): Promise<void> {
  // 1) Focused text input → blur and hide the IME. This avoids Android WebView
  //    focus deadlocks on search/template fields when back is pressed during
  //    keyboard resize.
  if (blurEditableAndHideKeyboard()) return;

  // 2) Open overlay → close it via Escape (Radix handles all primitives).
  if (hasOpenRadixOverlay()) {
    dispatchEscape();
    return;
  }
  // 3) Router history → back, but only when we're not on the root route.
  //    On the home screen, Android's expected behaviour is "double-tap to
  //    quit" — never silently rewind a stale browser history entry, which
  //    on a single-page app would either land on an empty state or crash
  //    the WebView when the popped state references unmounted components.
  if (!isRootRoute() && canGoBack && window.history.length > 1) {
    try {
      window.history.back();
    } catch {
      /* swallow — fall through to exit prompt */
    }
    return;
  }
  // 4) Root → behave like a native Android app: leave/minimize immediately.
  await leaveAppFromRoot();
}

export async function initAndroidBack(): Promise<void> {
  if (initialised) return;
  initialised = true;

  if (!Capacitor.isNativePlatform()) return;

  // Track keyboard visibility — first back press should dismiss the keyboard.
  let keyboardVisible = false;
  Keyboard.addListener("keyboardWillShow", () => {
    keyboardVisible = true;
  }).catch(() => {});
  Keyboard.addListener("keyboardDidShow", () => {
    keyboardVisible = true;
  }).catch(() => {});
  Keyboard.addListener("keyboardWillHide", () => {
    keyboardVisible = false;
  }).catch(() => {});
  Keyboard.addListener("keyboardDidHide", () => {
    keyboardVisible = false;
  }).catch(() => {});

  App.addListener("backButton", async ({ canGoBack }: { canGoBack: boolean }) => {
    if (handlingBack) return;
    handlingBack = true;
    try {
      // a) Keyboard first.
      if (keyboardVisible) {
        keyboardVisible = false;
        if (!blurEditableAndHideKeyboard()) void Keyboard.hide().catch(() => {});
        return;
      }
      // b) Walk component handler stack (LIFO).
      for (let i = stack.length - 1; i >= 0; i--) {
        const fn = stack[i];
        try {
          const r = await fn();
          if (r === true) return;
        } catch {
          /* keep walking on handler failure */
        }
      }
      // c) Fallbacks.
      await defaultBack(!!canGoBack);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[TempoKey] backButton handler failed", err);
    } finally {
      window.setTimeout(() => {
        handlingBack = false;
      }, 80);
    }
  }).catch(() => {});
}