/**
 * Track name normalization + fuzzy matching for the AutoSync mode.
 *
 * The OCR text captured from the DiscDJ playlist is noisy: numeric prefixes
 * (`035_`, `01 - `), quality tags (`(256k)`, `[320]`, `HD`), audio-source
 * hints (`Official Music Video`), file extensions, and stray punctuation are
 * routinely appended. We normalize both sides (OCR + library) to a canonical
 * form and use a bigram Dice similarity to pick the best MixOrder track.
 *
 * Design invariants:
 *  - Normalization is lossy on purpose. Prefixes/numerics are always dropped.
 *  - Similarity is 0..1. A "confident" match requires:
 *      • score >= threshold (default 0.72)
 *      • runner-up gap >= 0.05 (rejects ambiguous ties)
 *  - The caller (robot) NEVER writes a BPM when confidence fails.
 */

const QUALITY_TAG_RE = /\((?:\d{2,4}\s*k(?:bps)?|hd|hq|remastered|remaster|remix|edit|clean|explicit)\)/gi;
const BRACKET_QUALITY_RE = /\[(?:\d{2,4}\s*k(?:bps)?|hd|hq|remastered|remaster|remix|edit|clean|explicit)\]/gi;
const OFFICIAL_TAG_RE = /\b(?:official|music|video|audio|lyric[s]?|clip|mv|hd|4k)\b/gi;
const NUMERIC_PREFIX_RE = /^[\s\W_]*(?:\d{1,4}[\s._\-–—]+)+/;
const EXTENSION_RE = /\.(mp3|wav|flac|m4a|aac|ogg|wma|aiff)$/i;
const BPM_MENTION_RE = /\bbpm\s*[:=]?\s*\d{2,3}(?:[.,]\d+)?/gi;
const FT_TAG_RE = /\b(?:feat|ft|featuring)\.?\s*/gi;

/**
 * Reduce a raw title (OCR or filename) to a canonical comparable string:
 * lowercased, no diacritics, no punctuation, no numeric prefix / quality
 * tags, single-spaced.
 */
export function normalizeTrackName(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input);

  // strip file extension
  s = s.replace(EXTENSION_RE, "");
  // remove BPM mentions embedded in the string (e.g. "BPM:134")
  s = s.replace(BPM_MENTION_RE, " ");
  // remove common quality tags (256k, HD, official video, remix, ...)
  s = s.replace(QUALITY_TAG_RE, " ").replace(BRACKET_QUALITY_RE, " ").replace(OFFICIAL_TAG_RE, " ");
  // normalize featuring markers
  s = s.replace(FT_TAG_RE, " ");
  // strip a leading numeric prefix like "035_" or "01 - "
  s = s.replace(NUMERIC_PREFIX_RE, "");
  // fold underscores/hyphens/dots into spaces
  s = s.replace(/[_\-–—.·|/\\]+/g, " ");
  // remove diacritics
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // drop remaining non-alphanumerics
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
  // collapse whitespace, lower-case
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}

/** Dice coefficient on character bigrams (order-tolerant, robust to typos). */
function diceBigram(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let totalA = 0;
  let totalB = 0;
  for (const v of A.values()) totalA += v;
  for (const v of B.values()) totalB += v;
  for (const [g, ca] of A) {
    const cb = B.get(g);
    if (cb) inter += Math.min(ca, cb);
  }
  return (2 * inter) / (totalA + totalB);
}

/**
 * Similarity in [0, 1] between two raw names. Both are normalized first.
 * A small bonus is added when one normalized form is a prefix/suffix of the
 * other — useful when the OCR only captures part of a long, scrolling name.
 */
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalizeTrackName(a);
  const nb = normalizeTrackName(b);
  if (!na || !nb) return 0;
  let score = diceBigram(na, nb);
  const long = na.length >= nb.length ? na : nb;
  const short = na.length >= nb.length ? nb : na;
  if (short.length >= 4 && long.includes(short)) {
    score = Math.min(1, score + 0.08);
  }
  return score;
}

export interface NameMatchCandidate<T> {
  item: T;
  score: number;
}

export interface NameMatchResult<T> {
  best: NameMatchCandidate<T> | null;
  runnerUp: NameMatchCandidate<T> | null;
  confident: boolean;
  /** All candidates sorted by score, best first. */
  ranked: Array<NameMatchCandidate<T>>;
}

/**
 * Find the best match among `items` for `ocrName`. `getName(item)` returns
 * the item's display name (typically the filename).
 *
 * Confidence rules:
 *  - best.score >= threshold
 *  - best.score - runnerUp.score >= ambiguityGap (default 0.05)
 */
export function findBestMatch<T>(
  ocrName: string,
  items: T[],
  getName: (item: T) => string | string[],
  options: { threshold?: number; ambiguityGap?: number } = {},
): NameMatchResult<T> {
  const threshold = options.threshold ?? 0.55;
  const gap = options.ambiguityGap ?? 0.05;
  const normOcr = normalizeTrackName(ocrName);
  if (!normOcr || items.length === 0) {
    return { best: null, runnerUp: null, confident: false, ranked: [] };
  }
  const ranked = items
    .map((item) => {
      const names = getName(item);
      const list = Array.isArray(names) ? names : [names];
      let best = 0;
      for (const n of list) {
        const s = similarity(normOcr, n);
        if (s > best) best = s;
      }
      return { item, score: best };
    })
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;
  // Two acceptance paths, both require the runner-up gap to avoid ties:
  //  1. Clean confident match: best.score ≥ threshold.
  //  2. Dominance rescue: OCR often only captures part of a scrolling title,
  //     so a moderate score (≥ 0.42) that clearly beats the field (gap ≥ 0.15)
  //     is still a reliable pick — much better than "no match".
  const gapOk = !runnerUp || best!.score - runnerUp.score >= gap;
  const domGapOk = !runnerUp || best!.score - runnerUp.score >= 0.15;
  const confident =
    !!best &&
    ((best.score >= threshold && gapOk) || (best.score >= 0.42 && domGapOk));
  return { best, runnerUp, confident, ranked };
}
