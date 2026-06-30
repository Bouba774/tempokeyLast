/**
 * Small Android WebView stability helpers.
 *
 * These helpers are intentionally no-ops on web/desktop. In the APK they keep
 * input focus, keyboard resize and overlay closing on the safest path for
 * Android System WebView: blur before closing, then scroll after the native IME
 * has started resizing instead of during the pointer/focus event itself.
 */

export function isNativeAndroidUi(): boolean {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  return (
    document.documentElement.classList.contains("native-android") ||
    /Android/i.test(navigator.userAgent)
  );
}

function isEditableElement(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

export function blurAndroidActiveElement(): void {
  if (!isNativeAndroidUi()) return;
  const active = document.activeElement;
  if (!isEditableElement(active)) return;
  try {
    active.blur();
  } catch {
    /* no-op */
  }
}

export function closeAndroidSafe(onClose: () => void): void {
  blurAndroidActiveElement();
  if (!isNativeAndroidUi()) {
    onClose();
    return;
  }

  // Let the native pointer/keyboard cycle finish before unmounting the panel.
  window.requestAnimationFrame(() => {
    try {
      onClose();
    } catch {
      window.setTimeout(onClose, 0);
    }
  });
}

export function stabilizeAndroidFocus(
  element: HTMLElement,
  options: ScrollIntoViewOptions = { block: "center", inline: "nearest" },
): void {
  if (!isNativeAndroidUi()) return;

  document.documentElement.classList.add("android-input-active");

  const scroll = () => {
    if (!document.contains(element)) return;
    try {
      element.scrollIntoView({ behavior: "auto", ...options });
    } catch {
      /* no-op */
    }
  };

  window.requestAnimationFrame(scroll);
  window.setTimeout(scroll, 90);
  window.setTimeout(scroll, 240);
}

export function releaseAndroidFocusMarker(): void {
  if (!isNativeAndroidUi()) return;
  window.setTimeout(() => {
    if (!isEditableElement(document.activeElement)) {
      document.documentElement.classList.remove("android-input-active");
    }
  }, 180);
}