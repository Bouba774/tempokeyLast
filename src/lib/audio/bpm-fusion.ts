// Multi-algorithm BPM fusion engine.
//
// Combines several Essentia.js tempo estimators (RhythmExtractor2013,
// PercivalBpmEstimator, LoopBpmEstimator when available, plus a direct
// beat-interval estimator) computed on the full track and on several
// representative segments (intro / start / middle / main / outro), then
// merges all candidates by tempo family (treating half / double / 2:3 /
// 3:2 multiples as the same tempo) and picks the best scoring one.
//
// The goal is to match the BPM values reported by Rekordbox / Serato /
// VirtualDJ on tricky material (Afrobeats, Amapiano, House, Techno,
// Hip-Hop, Dancehall, Reggaeton, Pop, Live, Remix, Mashup).

import { freeVectors, type EssentiaInstance, type EssentiaVector } from "./essentia-engine";

const DJ_PREF_MIN = 85;
const DJ_PREF_MAX = 175;
const DEV_LOG =
  typeof window !== "undefined" &&
  ((window as unknown as { __TEMPOKEY_DEBUG_BPM__?: boolean }).__TEMPOKEY_DEBUG_BPM__ === true ||
    (typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true));

function devLog(...args: unknown[]): void {
  if (!DEV_LOG) return;
  // eslint-disable-next-line no-console
  console.log("[bpm-fusion]", ...args);
}

export interface BpmReading {
  algo: string;
  segment: string;
  bpm: number;
  confidence: number; // 0..1
  weight: number;     // prior weight (algo trust × segment importance)
  intervalsCv?: number;
}

export interface BpmFusionResult {
  bpm: number;            // chosen BPM, 2 decimals
  confidence: number;     // 0..1
  readings: BpmReading[]; // every raw reading collected
  candidates: { bpm: number; score: number; count: number }[];
  chosen: { bpm: number; score: number; count: number };
  validated: boolean;
  switchedToRunnerUp: boolean;
}

/** Coefficient of variation of an interval sequence (lower = steadier). */
export function intervalsCv(intervals: number[]): number {
  if (intervals.length < 4) return 1;
  let mean = 0;
  for (const v of intervals) mean += v;
  mean /= intervals.length;
  if (mean <= 0) return 1;
  let varSum = 0;
  for (const v of intervals) varSum += (v - mean) * (v - mean);
  return Math.sqrt(varSum / intervals.length) / mean;
}

/** Bring an arbitrary BPM into the DJ-friendly [70..180] window via x2/÷2. */
function toDjWindow(bpm: number): number {
  if (!isFinite(bpm) || bpm <= 0) return bpm;
  let b = bpm;
  let guard = 0;
  while (b < 70 && guard++ < 10) b *= 2;
  guard = 0;
  while (b > 180 && guard++ < 10) b /= 2;
  return b;
}

/**
 * Return every "equivalent" tempo for a reading: the value itself plus its
 * x0.5 / x2 / x3 / x⅔ / x1.5 / x⅓ multiples that still fall in a sensible
 * range. We then bucket on the DJ-window projection so that 64, 128 and 256
 * BPM (or 90 / 180 / 60, 87 / 174, etc.) collapse into the same family.
 */
function familyKey(bpm: number): string {
  return (Math.round(toDjWindow(bpm) * 2) / 2).toFixed(1);
}

// ---------------------------------------------------------------------------
// Essentia wrappers (each returns null on failure so the engine is resilient).
// ---------------------------------------------------------------------------

interface RhythmOut {
  bpm: number;
  confidence: number;
  intervals: number[];
  ticksCount: number;
}

function rhythmExtractor(
  essentia: EssentiaInstance,
  samples: Float32Array,
): RhythmOut | null {
  const buf = new Float32Array(samples.length);
  buf.set(samples);
  const vec = essentia.arrayToVector(buf);
  try {
    const out = essentia.RhythmExtractor2013(vec, 208, "multifeature", 40);
    const intervals: number[] = [];
    if (out.bpmIntervals) {
      const n = out.bpmIntervals.size();
      for (let i = 0; i < n; i++) intervals.push(out.bpmIntervals.get(i));
    }
    const ticksCount = out.ticks ? out.ticks.size() : 0;
    const res: RhythmOut = {
      bpm: out.bpm,
      // Essentia returns confidence in [0..5.32]; map to [0..1].
      confidence: Math.max(0, Math.min(1, out.confidence / 3.5)),
      intervals,
      ticksCount,
    };
    freeVectors(out.ticks as EssentiaVector, out.estimates as EssentiaVector, out.bpmIntervals as EssentiaVector);
    return res;
  } catch (e) {
    devLog("RhythmExtractor2013 failed:", e);
    return null;
  } finally {
    freeVectors(vec);
  }
}

function percival(essentia: EssentiaInstance, samples: Float32Array): number | null {
  const buf = new Float32Array(samples.length);
  buf.set(samples);
  const vec = essentia.arrayToVector(buf);
  try {
    const out = essentia.PercivalBpmEstimator(vec, 1024, 2048, 128, 128, 210, 50, 44100);
    return out.bpm > 0 ? out.bpm : null;
  } catch (e) {
    devLog("PercivalBpmEstimator failed:", e);
    return null;
  } finally {
    freeVectors(vec);
  }
}

function loopBpm(essentia: EssentiaInstance, samples: Float32Array): number | null {
  // LoopBpmEstimator is part of standard Essentia but may not be exposed by
  // every essentia.js build, so guard the call.
  const dyn = essentia as unknown as {
    LoopBpmEstimator?: (s: EssentiaVector, c?: number, sr?: number) => { bpm: number };
  };
  if (typeof dyn.LoopBpmEstimator !== "function") return null;
  const buf = new Float32Array(samples.length);
  buf.set(samples);
  const vec = essentia.arrayToVector(buf);
  try {
    const out = dyn.LoopBpmEstimator(vec, 0.85, 44100);
    return out.bpm > 0 ? out.bpm : null;
  } catch (e) {
    devLog("LoopBpmEstimator failed:", e);
    return null;
  } finally {
    freeVectors(vec);
  }
}

/** BPM derived directly from the median inter-beat interval of the ticks. */
function bpmFromIntervals(intervals: number[]): { bpm: number; cv: number } | null {
  if (intervals.length < 4) return null;
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!isFinite(median) || median <= 0) return null;
  return { bpm: 60 / median, cv: intervalsCv(intervals) };
}

// ---------------------------------------------------------------------------
// Scoring & fusion
// ---------------------------------------------------------------------------

interface SegmentRef {
  name: string;
  samples: Float32Array;
  weight: number;
}

/**
 * Five overlapping windows: intro, start, middle, main, outro. Each window is
 * up to 30 s long. Short tracks fall back to the full signal.
 */
export function pickBpmSegments(samples: Float32Array, sampleRate: number, maxSec = 30): SegmentRef[] {
  const totalSec = samples.length / sampleRate;
  if (totalSec < 12) return [{ name: "full", samples, weight: 1 }];
  const winLen = Math.min(samples.length, Math.floor(maxSec * sampleRate));
  const out: SegmentRef[] = [];
  const push = (name: string, startSec: number, weight: number) => {
    const start = Math.max(0, Math.min(samples.length - winLen, Math.floor(startSec * sampleRate)));
    out.push({ name, samples: samples.subarray(start, start + winLen), weight });
  };
  push("intro", 4, 0.6);
  push("start", Math.max(0, totalSec * 0.2 - maxSec / 2), 0.9);
  push("middle", Math.max(0, totalSec * 0.5 - maxSec / 2), 1.2);
  push("main", Math.max(0, totalSec * 0.7 - maxSec / 2), 1.0);
  push("outro", Math.max(0, totalSec - maxSec - 4), 0.6);
  return out;
}

function inDjWindow(bpm: number): number {
  const b = toDjWindow(bpm);
  if (b >= DJ_PREF_MIN && b <= DJ_PREF_MAX) return 1;
  if (b >= 70 && b <= 185) return 0.75;
  return 0.45;
}

/**
 * Collect raw readings from every algorithm × segment combination.
 */
export async function collectBpmReadings(
  essentia: EssentiaInstance,
  fullSamples: Float32Array,
  sampleRate: number,
): Promise<{ readings: BpmReading[]; fullRhythm: RhythmOut | null }> {
  const readings: BpmReading[] = [];
  const yieldTick = () => new Promise<void>((r) => setTimeout(r, 0));

  // -------- Full track ------------------------------------------------------
  await yieldTick();
  const fullRhythm = rhythmExtractor(essentia, fullSamples);
  if (fullRhythm && fullRhythm.bpm > 0) {
    const cv = intervalsCv(fullRhythm.intervals);
    readings.push({
      algo: "RhythmExtractor2013",
      segment: "full",
      bpm: fullRhythm.bpm,
      confidence: fullRhythm.confidence,
      weight: 1.8,
      intervalsCv: cv,
    });
    const fromIntervals = bpmFromIntervals(fullRhythm.intervals);
    if (fromIntervals) {
      readings.push({
        algo: "BeatIntervals",
        segment: "full",
        bpm: fromIntervals.bpm,
        confidence: Math.max(0.2, 1 - Math.min(0.9, fromIntervals.cv * 2)),
        weight: 1.0,
        intervalsCv: fromIntervals.cv,
      });
    }
  }

  await yieldTick();
  const fullPercival = percival(essentia, fullSamples);
  if (fullPercival) {
    readings.push({
      algo: "PercivalBpmEstimator",
      segment: "full",
      bpm: fullPercival,
      confidence: 0.7,
      weight: 1.4,
    });
  }

  await yieldTick();
  const fullLoop = loopBpm(essentia, fullSamples);
  if (fullLoop) {
    readings.push({
      algo: "LoopBpmEstimator",
      segment: "full",
      bpm: fullLoop,
      confidence: 0.65,
      weight: 1.1,
    });
  }

  // -------- Segments --------------------------------------------------------
  const segs = pickBpmSegments(fullSamples, sampleRate, 30);
  for (const seg of segs) {
    if (seg.name === "full") continue;
    await yieldTick();
    const r = rhythmExtractor(essentia, seg.samples);
    if (r && r.bpm > 0) {
      const cv = intervalsCv(r.intervals);
      readings.push({
        algo: "RhythmExtractor2013",
        segment: seg.name,
        bpm: r.bpm,
        confidence: r.confidence,
        weight: 1.0 * seg.weight,
        intervalsCv: cv,
      });
    }
    await yieldTick();
    const p = percival(essentia, seg.samples);
    if (p) {
      readings.push({
        algo: "PercivalBpmEstimator",
        segment: seg.name,
        bpm: p,
        confidence: 0.6,
        weight: 0.8 * seg.weight,
      });
    }
  }

  devLog(`collected ${readings.length} readings`, readings.map((r) => ({ a: r.algo, s: r.segment, b: +r.bpm.toFixed(2), c: +r.confidence.toFixed(2) })));
  return { readings, fullRhythm };
}

interface Group {
  key: string;
  bpmDjWindow: number;        // canonical (DJ-window) tempo for the family
  weightedBpmSum: number;     // for weighted average
  weightSum: number;
  totalScore: number;
  count: number;
  algos: Set<string>;
  segments: Set<string>;
  confSum: number;
  cvSum: number;
  cvCount: number;
}

function readingScore(r: BpmReading): number {
  const stability = r.intervalsCv != null ? 1 - Math.min(0.6, r.intervalsCv) : 0.7;
  return r.weight * (0.4 + 0.6 * r.confidence) * (0.5 + 0.5 * stability) * inDjWindow(r.bpm);
}

function groupReadings(readings: BpmReading[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const r of readings) {
    const dj = toDjWindow(r.bpm);
    const key = familyKey(r.bpm);
    const w = readingScore(r);
    const g = groups.get(key) ?? {
      key,
      bpmDjWindow: dj,
      weightedBpmSum: 0,
      weightSum: 0,
      totalScore: 0,
      count: 0,
      algos: new Set<string>(),
      segments: new Set<string>(),
      confSum: 0,
      cvSum: 0,
      cvCount: 0,
    };
    g.weightedBpmSum += dj * w;
    g.weightSum += w;
    g.totalScore += w;
    g.count += 1;
    g.algos.add(r.algo);
    g.segments.add(r.segment);
    g.confSum += r.confidence;
    if (r.intervalsCv != null) {
      g.cvSum += r.intervalsCv;
      g.cvCount += 1;
    }
    groups.set(key, g);
  }
  // Refine canonical BPM as weighted average of the DJ-window projections.
  for (const g of groups.values()) {
    if (g.weightSum > 0) g.bpmDjWindow = g.weightedBpmSum / g.weightSum;
    // Bonus for algorithm diversity, segment coverage, and DJ-window fit.
    const diversityBonus = 1 + 0.15 * (g.algos.size - 1);
    const coverageBonus = 1 + 0.08 * (g.segments.size - 1);
    const djBonus = inDjWindow(g.bpmDjWindow);
    g.totalScore *= diversityBonus * coverageBonus * djBonus;
  }
  return groups;
}

function rankGroups(groups: Map<string, Group>): Group[] {
  return Array.from(groups.values()).sort((a, b) => {
    if (Math.abs(a.totalScore - b.totalScore) < 1e-6) return b.algos.size - a.algos.size;
    return b.totalScore - a.totalScore;
  });
}

/**
 * Validate a candidate BPM against the full-track ticks: check that the
 * inter-beat intervals scaled to the candidate tempo stay regular. Returns
 * true when the candidate is consistent with the actual beat grid.
 */
function validateAgainstTicks(candidateBpm: number, fullRhythm: RhythmOut | null): boolean {
  if (!fullRhythm || fullRhythm.intervals.length < 4) return true;
  // Project the candidate tempo onto the same octave as the median interval.
  const sorted = [...fullRhythm.intervals].sort((a, b) => a - b);
  const medianInterval = sorted[Math.floor(sorted.length / 2)];
  if (!isFinite(medianInterval) || medianInterval <= 0) return true;
  const candidateInterval = 60 / candidateBpm;
  // Find the multiplier that best aligns the candidate to the observed median.
  let bestRatio = Infinity;
  for (const mult of [0.25, 0.5, 1, 2, 4, 2 / 3, 1.5, 3]) {
    const r = (candidateInterval * mult) / medianInterval;
    const diff = Math.abs(Math.log2(r));
    if (diff < bestRatio) bestRatio = diff;
  }
  const aligned = bestRatio < 0.08; // within ~5.7 % of an octave-equivalent
  const cv = intervalsCv(fullRhythm.intervals);
  return aligned && cv < 0.28;
}

/**
 * Snap the canonical (DJ-window) BPM to an integer if every reading agrees
 * within ±0.4 BPM — DJ apps display integer tempi when the track is steady.
 */
function snapBpm(bpmDjWindow: number, readings: BpmReading[], key: string): number {
  const projected = readings
    .filter((r) => familyKey(r.bpm) === key)
    .map((r) => toDjWindow(r.bpm));
  if (projected.length === 0) return bpmDjWindow;
  const rounded = Math.round(bpmDjWindow);
  const allClose = projected.every((p) => Math.abs(p - rounded) < 0.4);
  if (allClose) return rounded;
  return Math.round(bpmDjWindow * 100) / 100;
}

export function fuseBpm(
  readings: BpmReading[],
  fullRhythm: RhythmOut | null,
): BpmFusionResult | null {
  if (readings.length === 0) return null;
  const groups = groupReadings(readings);
  const ranked = rankGroups(groups);
  if (ranked.length === 0) return null;

  let chosen = ranked[0];
  const runner = ranked[1];

  // Tie-break very close candidates by algorithm agreement count.
  if (runner && runner.totalScore / chosen.totalScore > 0.92) {
    if (runner.algos.size > chosen.algos.size) {
      devLog("tie-break: runner has more algos, swapping", { chosen: chosen.key, runner: runner.key });
      chosen = runner;
    }
  }

  let switched = false;
  let validated = validateAgainstTicks(chosen.bpmDjWindow, fullRhythm);
  if (!validated && runner) {
    devLog("validation failed for", chosen.key, "falling back to", runner.key);
    chosen = runner;
    validated = validateAgainstTicks(chosen.bpmDjWindow, fullRhythm);
    switched = true;
  }

  const finalBpm = snapBpm(chosen.bpmDjWindow, readings, chosen.key);

  // Robust confidence: blend algorithm agreement, average per-reading
  // confidence, beat-grid stability, and segment coherence.
  const totalAlgos = new Set(readings.map((r) => r.algo)).size;
  const totalSegments = new Set(readings.map((r) => r.segment)).size;
  const agreement = chosen.algos.size / Math.max(1, totalAlgos);
  const coverage = chosen.segments.size / Math.max(1, totalSegments);
  const avgConf = chosen.confSum / Math.max(1, chosen.count);
  const stability = chosen.cvCount > 0 ? 1 - Math.min(0.6, chosen.cvSum / chosen.cvCount) : 0.7;
  // Margin over runner-up boosts certainty.
  const margin = runner ? Math.max(0, Math.min(1, (chosen.totalScore - runner.totalScore) / chosen.totalScore)) : 1;
  let confidence =
    0.3 * agreement +
    0.2 * coverage +
    0.2 * avgConf +
    0.2 * stability +
    0.1 * margin;
  if (!validated) confidence *= 0.7;
  confidence = Math.max(0, Math.min(1, confidence));

  const candidates = ranked.slice(0, 6).map((g) => ({
    bpm: Math.round(g.bpmDjWindow * 100) / 100,
    score: Math.round(g.totalScore * 1000) / 1000,
    count: g.count,
  }));

  devLog("decision", {
    finalBpm,
    confidence: +confidence.toFixed(3),
    validated,
    switched,
    candidates,
    chosen: { key: chosen.key, algos: [...chosen.algos], segments: [...chosen.segments], score: chosen.totalScore },
  });

  return {
    bpm: finalBpm,
    confidence: Math.round(confidence * 100) / 100,
    readings,
    candidates,
    chosen: { bpm: finalBpm, score: chosen.totalScore, count: chosen.count },
    validated,
    switchedToRunnerUp: switched,
  };
}

export async function analyzeBpmFusion(
  essentia: EssentiaInstance,
  fullSamples: Float32Array,
  sampleRate: number,
): Promise<BpmFusionResult | null> {
  const { readings, fullRhythm } = await collectBpmReadings(essentia, fullSamples, sampleRate);
  return fuseBpm(readings, fullRhythm);
}
