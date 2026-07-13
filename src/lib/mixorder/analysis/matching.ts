import type { Track } from "@/lib/workspace-context";

/**
 * Intelligent title matching between DiscDJ readings and MixOrder tracks.
 *
 * Rules (see spec):
 *  - Never rely on playlist order — match on displayed title + duration.
 *  - Tolerant normalization: strip diacritics, extensions, leading numeric
 *    prefixes (e.g. "035_", "12 - "), separators and punctuation, collapse
 *    whitespace.
 *  - Duration (when both sides know it) validates or invalidates a name
 *    match with a small tolerance.
 *  - Ambiguity is not resolved silently: return candidates and let the UI
 *    ask the user.
 *
 * All heuristics live here so the robot loop stays a thin orchestrator and
 * future upgrades (fingerprint hashing, ML, tag inspection) don't leak
 * across the codebase.
 */

/** ±N seconds tolerance when validating that two tracks have "the same" length. */
export const DURATION_TOLERANCE_SEC = 2.5;

/** Score >= this is a confident single-candidate match. */
export const CONFIDENT_SCORE = 0.86;
/** Runner-up must stay below this to keep a match unambiguous. */
export const AMBIGUOUS_GAP = 0.08;

/** Normalize a raw title down to comparable tokens. */
export function normalizeTitle(input: string): string {
  if (!input) return "";
  let s = input.toLowerCase();
  // Strip diacritics.
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Drop known audio extensions.
  s = s.replace(/\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|wma)$/i, "");
  // Drop leading track numbers / prefixes: "035_", "12 - ", "07.", "(04) ".
  s = s.replace(/^[\s\-_.()[\]#]*\d{1,4}[\s\-_.()[\]]+/, "");
  // Drop bracketed metadata that rarely helps: (Original Mix), [Clean], {Radio Edit}.
  s = s.replace(/[\[({][^\])}]*[\])}]/g, " ");
  // Replace any non-alphanumeric with space.
  s = s.replace(/[^a-z0-9]+/g, " ");
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Split into unique word tokens after normalization. */
export function tokenize(input: string): string[] {
  const n = normalizeTitle(input);
  if (!n) return [];
  return Array.from(new Set(n.split(" ").filter((t) => t.length > 1)));
}

/**
 * Title similarity in [0, 1]. Combines:
 *  - Jaccard on unique tokens (order-independent, tolerant to reorderings).
 *  - Levenshtein ratio on the full normalized strings (catches typos and
 *    short titles where token overlap is noisy).
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  let inter = 0;
  ta.forEach((t) => tb.has(t) && inter++);
  const union = ta.size + tb.size - inter;
  const jaccard = union > 0 ? inter / union : 0;

  const lev = levenshteinRatio(na, nb);
  // Weighted: token overlap dominates for multi-word titles, string ratio
  // rescues single-word / typo cases.
  return Math.max(jaccard * 0.7 + lev * 0.3, lev * 0.85);
}

function levenshteinRatio(a: string, b: string): number {
  const d = levenshtein(a, b);
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - d / m;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length,
    bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const v0 = new Array<number>(bl + 1);
  const v1 = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) v0[j] = j;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a.charCodeAt(i) === b.charCodeAt(j) ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= bl; j++) v0[j] = v1[j];
  }
  return v0[bl];
}

export interface MatchCandidate {
  track: Track;
  score: number;
  /** How well durations agree, in [0, 1]. `null` if we can't compare. */
  durationScore: number | null;
  /** Composite score used for ranking (title + duration blend). */
  combined: number;
}

export interface MatchResult {
  candidates: MatchCandidate[];
  /** Single confident match, or null if ambiguous / none. */
  confident: MatchCandidate | null;
  /** True when at least one plausible candidate exists but none is confident. */
  ambiguous: boolean;
}

export interface ReadingProbe {
  title: string | null;
  durationSec: number | null;
}

/**
 * Rank library tracks against a DiscDJ reading. Only `tracks` passed in
 * are considered — the caller decides which are eligible (typically:
 * tracks that still need a BPM).
 */
export function findMatches(
  reading: ReadingProbe,
  tracks: Track[],
): MatchResult {
  const empty: MatchResult = { candidates: [], confident: null, ambiguous: false };
  if (!reading.title || tracks.length === 0) return empty;

  const scored: MatchCandidate[] = [];
  for (const track of tracks) {
    const nameScore = Math.max(
      titleSimilarity(reading.title, track.name),
      titleSimilarity(reading.title, track.originalName),
    );
    if (nameScore < 0.35) continue;

    let durationScore: number | null = null;
    if (reading.durationSec != null && track.durationSec != null) {
      const delta = Math.abs(reading.durationSec - track.durationSec);
      if (delta > DURATION_TOLERANCE_SEC * 4) continue; // hard reject
      // Linear falloff over the tolerance window.
      durationScore = Math.max(0, 1 - delta / (DURATION_TOLERANCE_SEC * 2));
    }

    const combined =
      durationScore == null
        ? nameScore
        : nameScore * 0.7 + durationScore * 0.3;

    scored.push({ track, score: nameScore, durationScore, combined });
  }

  scored.sort((a, b) => b.combined - a.combined);
  const top = scored[0];
  if (!top) return empty;

  const runnerUp = scored[1];
  const durationOk =
    top.durationScore == null || top.durationScore >= 0.5;
  const confidentByScore =
    top.combined >= CONFIDENT_SCORE &&
    (!runnerUp || top.combined - runnerUp.combined >= AMBIGUOUS_GAP);

  const confident = confidentByScore && durationOk ? top : null;

  return {
    candidates: scored.slice(0, 5),
    confident,
    ambiguous: !confident && scored.length > 0,
  };
}
