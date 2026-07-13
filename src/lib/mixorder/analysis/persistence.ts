import type { Track } from "@/lib/workspace-context";
import type {
  AnalysisSnapshot,
  AnalyzedTrackData,
  BpmSourceId,
} from "./types";

/**
 * Local persistence of analysis results.
 *
 * Keyed by a stable fingerprint (project name + sorted track paths) so BPMs
 * survive project close/reopen and future imports of the same folder. The
 * snapshot is intentionally decoupled from `Track.id` (which regenerates on
 * every import) — we key on `Track.path`, which is stable.
 */

const PREFIX = "mixorder:project:";
const INDEX_KEY = "mixorder:projects:index";

export function projectFingerprint(project: {
  name: string;
  tracks: Array<{ path: string }>;
}): string {
  const paths = project.tracks
    .map((t) => t.path)
    .sort()
    .join("|");
  const s = `${project.name}::${paths}`;
  // 32-bit FNV-1a — deterministic across sessions, small key.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadSnapshot(fingerprint: string): AnalysisSnapshot | null {
  const s = safeStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(PREFIX + fingerprint);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AnalysisSnapshot;
    if (parsed?.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSnapshot(
  fingerprint: string,
  snapshot: AnalysisSnapshot,
): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(PREFIX + fingerprint, JSON.stringify(snapshot));
    // Best-effort index for future features (list of known projects).
    const idxRaw = s.getItem(INDEX_KEY);
    const idx: Record<string, { name: string; updatedAt: number }> = idxRaw
      ? JSON.parse(idxRaw)
      : {};
    idx[fingerprint] = { name: snapshot.name, updatedAt: Date.now() };
    s.setItem(INDEX_KEY, JSON.stringify(idx));
  } catch {
    /* quota exceeded etc. — ignore */
  }
}

export function applyAnalysisToTracks(
  tracks: Track[],
  snapshot: AnalysisSnapshot | null,
): Track[] {
  if (!snapshot) return tracks;
  let changed = false;
  const next = tracks.map((t) => {
    const d = snapshot.tracks[t.path];
    if (!d) return t;
    const bpm = d.bpm ?? t.bpm;
    const musicalKey = d.musicalKey ?? t.musicalKey;
    if (bpm === t.bpm && musicalKey === t.musicalKey) return t;
    changed = true;
    return { ...t, bpm, musicalKey };
  });
  return changed ? next : tracks;
}

export function upsertTrackData(
  snapshot: AnalysisSnapshot | null,
  projectName: string,
  path: string,
  patch: Partial<AnalyzedTrackData> & { source: BpmSourceId },
): AnalysisSnapshot {
  const base: AnalysisSnapshot = snapshot
    ? { ...snapshot, tracks: { ...snapshot.tracks } }
    : { v: 1, name: projectName, tracks: {} };
  base.name = projectName;
  const existing = base.tracks[path];
  base.tracks[path] = {
    bpm: patch.bpm !== undefined ? patch.bpm : existing?.bpm ?? null,
    musicalKey:
      patch.musicalKey !== undefined
        ? patch.musicalKey
        : existing?.musicalKey ?? null,
    updatedAt: Date.now(),
    source: patch.source,
    needsReanalysis:
      patch.needsReanalysis !== undefined
        ? patch.needsReanalysis
        : existing?.needsReanalysis,
  };
  return base;
}

export function markRun(
  snapshot: AnalysisSnapshot,
  projectName: string,
  run: AnalysisSnapshot["currentRun"],
): AnalysisSnapshot {
  return { ...snapshot, name: projectName, currentRun: run };
}

/**
 * Remember that a normalized DiscDJ title maps to a MixOrder track path.
 * Reused on future runs to short-circuit fuzzy matching and to bias
 * ambiguity resolution toward previously confirmed choices.
 */
export function rememberAlias(
  snapshot: AnalysisSnapshot | null,
  projectName: string,
  normalizedTitle: string,
  path: string,
): AnalysisSnapshot {
  const base: AnalysisSnapshot = snapshot
    ? { ...snapshot, aliases: { ...(snapshot.aliases ?? {}) } }
    : { v: 1, name: projectName, tracks: {}, aliases: {} };
  base.name = projectName;
  if (!base.aliases) base.aliases = {};
  base.aliases[normalizedTitle] = path;
  return base;
}

export function lookupAlias(
  snapshot: AnalysisSnapshot | null,
  normalizedTitle: string,
): string | null {
  return snapshot?.aliases?.[normalizedTitle] ?? null;
}
