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
const store = createStore("tempokey-analysis-v6-fusion", "cache");

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
