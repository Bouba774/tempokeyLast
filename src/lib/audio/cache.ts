import { createStore, get as idbGet, set as idbSet } from "idb-keyval";
import type { BpmCandidate } from "./bpm";

export interface TrackAnalysis {
  fileHash: string;
  bpm: number | null;
  bpmConfidence: number | null;
  bpmCandidates: BpmCandidate[];
  key: string | null; // human label, e.g. "A minor"
  keyConfidence: number | null;
  camelot: string | null; // e.g. "8A"
  durationSec: number;
  suspect: boolean;
  analyzedAt: number;
}

// Bump the store name whenever the analysis algorithm changes so that
// existing libraries are transparently re-analysed with the new engine.
// v7-audit: VampCompat + new fusion + octave snap + multi-range sweep.
// Any track cached under an older store is invisible to this build, which
// forces the new engine to run and its logs to appear.
const CACHE_STORE_VERSION = "tempokey-analysis-v7-audit";
const store = createStore(CACHE_STORE_VERSION, "cache");

export const CACHE_VERSION = CACHE_STORE_VERSION;

export async function getCachedAnalysis(fileHash: string): Promise<TrackAnalysis | null> {
  try {
    const v = (await idbGet(fileHash, store)) as TrackAnalysis | undefined;
    return v ?? null;
  } catch {
    return null;
  }
}

export async function setCachedAnalysis(a: TrackAnalysis): Promise<void> {
  try {
    await idbSet(a.fileHash, a, store);
  } catch {
    // ignore – analysis cache is non-critical
  }
}
