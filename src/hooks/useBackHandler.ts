import { useEffect, useRef } from "react";
import { pushBackHandler, type BackHandler } from "@/lib/android-back";

/**
 * Register a component-scoped Android back-button handler.
 *
 * The handler is only active while `active === true`. Return `true` from the
 * handler to consume the back event; return `false`/`undefined` to fall
 * through to the next handler (or to the built-in fallbacks).
 *
 * The most-recently registered active handler runs first (LIFO), so nested
 * UI (sheet inside a screen inside a tab) closes from the inside out.
 */
export function useBackHandler(active: boolean, handler: BackHandler): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!active) return;
    const off = pushBackHandler(() => handlerRef.current());
    return off;
  }, [active]);
}