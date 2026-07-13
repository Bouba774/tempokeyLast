import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Global "Mode MixOrder" toggle.
 *
 * Preparation-only: when enabled BEFORE importing a library, the home page
 * routes the user to /mixorder instead of /workspace after import (and when
 * re-opening a recent library). TempoKey's data model, library store, cache
 * and analysis pipeline are unchanged and shared with the future MixOrder
 * surface — both entry points read/write the same underlying state.
 */
interface MixOrderModeState {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
}

export const useMixOrderModeStore = create<MixOrderModeState>()(
  persist(
    (set, get) => ({
      enabled: false,
      setEnabled: (v) => set({ enabled: !!v }),
      toggle: () => set({ enabled: !get().enabled }),
    }),
    {
      name: "tempokey.mixorder-mode.v1",
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.localStorage : (undefined as never),
      ),
    },
  ),
);

export function isMixOrderModeEnabled(): boolean {
  try {
    return useMixOrderModeStore.getState().enabled;
  } catch {
    return false;
  }
}