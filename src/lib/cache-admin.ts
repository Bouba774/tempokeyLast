import { createStore, keys as idbKeys, clear as idbClear, del as idbDel } from "idb-keyval";
import { useLibraryStore } from "@/lib/library-store";

const analysisStore = createStore("tempokey-analysis", "cache");
const waveformStore = createStore("tempokey-waveform", "peaks");

export interface CacheStats {
  analysisCount: number;
  waveformCount: number;
  estimatedBytes: number | null;
  lastUpdated: number | null;
}

export async function readCacheStats(): Promise<CacheStats> {
  let analysisCount = 0;
  let waveformCount = 0;
  try {
    analysisCount = (await idbKeys(analysisStore)).length;
  } catch {}
  try {
    waveformCount = (await idbKeys(waveformStore)).length;
  } catch {}

  let estimatedBytes: number | null = null;
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    try {
      const e = await navigator.storage.estimate();
      estimatedBytes = typeof e.usage === "number" ? e.usage : null;
    } catch {}
  }

  // Last updated: max analyzedAt on tracks (cheap proxy).
  const lib = useLibraryStore.getState().library;
  let lastUpdated: number | null = null;
  if (lib) {
    for (const t of lib.tracks) {
      const at = t.detected?.detectedAt ?? null;
      if (at && (!lastUpdated || at > lastUpdated)) lastUpdated = at;
    }
  }

  return { analysisCount, waveformCount, estimatedBytes, lastUpdated };
}

export async function clearAllCaches(): Promise<void> {
  try {
    await idbClear(analysisStore);
  } catch {}
  try {
    await idbClear(waveformStore);
  } catch {}
}

export async function clearWaveformCache(): Promise<void> {
  try {
    await idbClear(waveformStore);
  } catch {}
}

/**
 * Remove cache entries that no longer correspond to tracks in the active library.
 */
export async function pruneOrphanCache(): Promise<{ removed: number }> {
  const lib = useLibraryStore.getState().library;
  const validHashes = new Set<string>();
  const validWaveformKeys = new Set<string>();
  if (lib) {
    for (const t of lib.tracks) {
      if (t.fileHash) validHashes.add(t.fileHash);
      // Waveform key currently uses track id (see Waveform component).
      validWaveformKeys.add(t.id);
    }
  }

  let removed = 0;
  try {
    const keys = await idbKeys(analysisStore);
    for (const k of keys) {
      if (typeof k === "string" && !validHashes.has(k)) {
        await idbDel(k, analysisStore);
        removed += 1;
      }
    }
  } catch {}
  try {
    const keys = await idbKeys(waveformStore);
    for (const k of keys) {
      if (typeof k === "string" && !validWaveformKeys.has(k)) {
        await idbDel(k, waveformStore);
        removed += 1;
      }
    }
  } catch {}
  return { removed };
}

export function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

export function formatRelativeDate(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "à l'instant";
  if (diff < hour) return `il y a ${Math.floor(diff / min)} min`;
  if (diff < day) return `il y a ${Math.floor(diff / hour)} h`;
  if (diff < 7 * day) return `il y a ${Math.floor(diff / day)} j`;
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}
