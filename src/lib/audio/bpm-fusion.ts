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
import { estimateBPM, estimateBPMVampCompat, type VampEstimate } from "./bpm";

const DJ_PREF_MIN = 85;
const DJ_PREF_MAX = 175;
// "Natural DJ pulse" — the sweet spot most DJ apps (DiscDJ, Rekordbox,
// Serato, VirtualDJ) prefer when several octave interpretations of the
// tempo are equally plausible. Used as a soft prior, never as a hard rule.
const DJ_NATURAL_MIN = 95;
const DJ_NATURAL_MAX = 145;
// Explicit multipliers evaluated for every top candidate — mirrors the
// half / double / dotted / triplet interpretations a DJ would consider.
const CANDIDATE_MULTIPLIERS = [0.5, 2 / 3, 0.75, 1, 1.25, 1.5, 2] as const;
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

/**
 * Vamp-like Fixed Tempo Estimator: autocorrelation of a multi-band
 * spectral-flux onset envelope with a 4-harmonic comb filter. This is
 * an independent, non-Essentia estimator that gives DiscDJ-style stable
 * tempi on Afrobeats / Amapiano / Dancehall / Reggaeton where beat
 * trackers often halve or double the tempo.
 */
function vampFixedTempo(samples: Float32Array, sampleRate: number): { bpm: number; confidence: number } | null {
  try {
    const est = estimateBPM(samples, sampleRate);
    if (!est.bpm || !isFinite(est.bpm) || est.bpm <= 0) return null;
    return { bpm: est.bpm, confidence: Math.max(0.15, Math.min(1, est.confidence)) };
  } catch (e) {
    devLog("vampFixedTempo failed:", e);
    return null;
  }
}

/**
 * Faithful Vamp FixedTempoEstimator (no comb filter, log-Gaussian prior at
 * 120, multi-range sweep). This is the DiscDJ compatibility layer: the
 * fusion engine treats its output as high-authority evidence and snaps
 * the final BPM toward it when non-octave disagreement is detected.
 */
function vampCompat(samples: Float32Array, sampleRate: number): VampEstimate | null {
  try {
    const est = estimateBPMVampCompat(samples, sampleRate);
    if (!est.bpm || !isFinite(est.bpm) || est.bpm <= 0) return null;
    return est;
  } catch (e) {
    devLog("vampCompat failed:", e);
    return null;
  }
}

/**
 * Multi-range Vamp sweep: run the DiscDJ-compat estimator with priors
 * anchored to five overlapping BPM windows and pick the window whose peak
 * is the strongest & most regular. Used as a second-pass when the fusion
 * layer detects strong disagreement between algorithms.
 */
function vampMultiRange(samples: Float32Array, sampleRate: number): { bpm: number; score: number; regularity: number } | null {
  const ranges: Array<[number, number, number]> = [
    [70, 95, 82],
    [95, 115, 105],
    [115, 140, 128],
    [140, 180, 155],
    [180, 220, 195],
  ];
  let best: { bpm: number; score: number; regularity: number } | null = null;
  for (const [lo, hi, pref] of ranges) {
    try {
      const est = estimateBPMVampCompat(samples, sampleRate, {
        preferredBpm: pref,
        sigma: 0.35,
        bpmRange: [lo, hi],
      });
      if (!est.bpm || est.candidates.length === 0) continue;
      const top = est.candidates[0];
      const combined = top.score * (0.5 + 0.5 * top.regularity);
      if (!best || combined > best.score) {
        best = { bpm: est.bpm, score: combined, regularity: top.regularity };
      }
    } catch (e) {
      devLog("vampMultiRange range failed:", lo, hi, e);
    }
  }
  return best;
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

  // ---- Vamp-like Fixed Tempo Estimator (autocorrelation + comb) -----------
  await yieldTick();
  const vamp = vampFixedTempo(fullSamples, sampleRate);
  if (vamp) {
    readings.push({
      algo: "VampFixedTempo",
      segment: "full",
      bpm: vamp.bpm,
      confidence: vamp.confidence,
      weight: 1.5,
    });
  }

  // ---- Vamp FixedTempoEstimator (DiscDJ-faithful, no comb filter) --------
  // High-authority reading: the fusion decision below snaps to this value
  // when it disagrees with the comb-based candidate at a non-octave ratio
  // (mirrors the systematic ×4/3, ×3/2 and ×2 mis-doubles observed
  // between TempoKey and DiscDJ on Afro / hip-hop / reggaeton material).
  await yieldTick();
  const vampC = vampCompat(fullSamples, sampleRate);
  if (vampC && vampC.bpm) {
    readings.push({
      algo: "VampCompat",
      segment: "full",
      bpm: vampC.bpm,
      confidence: Math.max(0.25, vampC.confidence),
      weight: 2.6,
    });
    // Feed the top alternate as a secondary observation so the fusion
    // grouping sees the full DiscDJ candidate landscape.
    for (const alt of vampC.candidates.slice(1, 3)) {
      readings.push({
        algo: "VampCompatAlt",
        segment: "full",
        bpm: alt.bpm,
        confidence: Math.max(0.1, alt.score),
        weight: 0.9,
      });
    }
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

/**
 * Cross-validation: down-weight readings that strongly disagree with the
 * consensus (median of DJ-window projections). An engine that lands alone
 * in a distant tempo family should not be able to drive the final result.
 */
function suppressOutliers(readings: BpmReading[]): BpmReading[] {
  if (readings.length < 3) return readings;
  const projected = readings.map((r) => toDjWindow(r.bpm)).sort((a, b) => a - b);
  const median = projected[Math.floor(projected.length / 2)];
  if (!isFinite(median) || median <= 0) return readings;
  return readings.map((r) => {
    const dj = toDjWindow(r.bpm);
    // Ratio-based deviation, tolerating the ×0.5/×2 octave siblings the
    // grouping step already handles.
    const ratio = dj / median;
    const octaveAligned =
      Math.min(
        Math.abs(Math.log2(ratio)),
        Math.abs(Math.log2(ratio * 2)),
        Math.abs(Math.log2(ratio / 2)),
      ) < 0.08;
    if (octaveAligned) return r;
    const dev = Math.abs(dj - median) / median;
    if (dev > 0.15) {
      const damped = { ...r, weight: r.weight * 0.35, confidence: r.confidence * 0.7 };
      devLog("outlier damped", { algo: r.algo, segment: r.segment, bpm: +r.bpm.toFixed(2), dev: +dev.toFixed(3) });
      return damped;
    }
    return r;
  });
}

/**
 * DJ-naturalness prior: peak value inside [95, 145], smoothly falling off
 * outside. Never zero — this is a *soft* preference, so mathematical
 * correctness always wins when the evidence is strong.
 */
function djNaturalness(bpmDjWindow: number): number {
  const b = bpmDjWindow;
  if (b >= DJ_NATURAL_MIN && b <= DJ_NATURAL_MAX) return 1;
  if (b >= 80 && b <= 165) return 0.9;
  if (b >= DJ_PREF_MIN && b <= DJ_PREF_MAX) return 0.8;
  return 0.65;
}

/**
 * Evaluate the explicit set of multipliers (÷2, ×2/3, ×0.75, ×1, ×1.25,
 * ×1.5, ×2) for each top-ranked family. For every multiplied candidate we
 * count how much *reading mass* (weight × confidence × stability) falls
 * within ±2 % of it, then combine that with the DJ-naturalness prior.
 * The winner is not necessarily the raw mathematical BPM but the one that
 * best matches how a DJ would count the pulse — the same behaviour DiscDJ
 * exhibits on ternary or half-time material.
 */
function pickBestMultiplier(baseBpmDjWindow: number, readings: BpmReading[]): { bpm: number; score: number; multiplier: number } {
  let best = { bpm: baseBpmDjWindow, score: -Infinity, multiplier: 1 };
  for (const m of CANDIDATE_MULTIPLIERS) {
    const cand = toDjWindow(baseBpmDjWindow * m);
    if (!isFinite(cand) || cand <= 0) continue;
    let mass = 0;
    for (const r of readings) {
      const rDj = toDjWindow(r.bpm);
      // Match on any octave-equivalent projection.
      const ratios = [rDj / cand, (rDj * 2) / cand, rDj / (cand * 2)];
      const near = ratios.some((x) => Math.abs(x - 1) < 0.02);
      if (!near) continue;
      const stability = r.intervalsCv != null ? 1 - Math.min(0.6, r.intervalsCv) : 0.7;
      mass += r.weight * (0.4 + 0.6 * r.confidence) * (0.5 + 0.5 * stability);
    }
    // Slight preference for staying on ×1 to avoid needless multiplier flips
    // when the evidence is a tie.
    const anchorBonus = m === 1 ? 1.05 : 1;
    const score = mass * djNaturalness(cand) * anchorBonus;
    if (score > best.score) best = { bpm: cand, score, multiplier: m };
  }
  return best;
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
  const cleaned = suppressOutliers(readings);
  const groups = groupReadings(cleaned);
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

  // DJ-oriented multiplier decision: re-evaluate ×0.5..×2 candidates
  // around the winning family and pick the pulse that best matches how a
  // DJ would count the beat (natural-pulse prior + reading-mass agreement).
  const mult = pickBestMultiplier(chosen.bpmDjWindow, cleaned);
  const decidedBpm = mult.bpm;
  const finalBpm = snapBpm(decidedBpm, cleaned, familyKey(decidedBpm));
  devLog("multiplier decision", { base: +chosen.bpmDjWindow.toFixed(2), picked: +decidedBpm.toFixed(2), multiplier: mult.multiplier, score: +mult.score.toFixed(3) });

  // Robust confidence: blend algorithm agreement, average per-reading
  // confidence, beat-grid stability, and segment coherence.
  const totalAlgos = new Set(cleaned.map((r) => r.algo)).size;
  const totalSegments = new Set(cleaned.map((r) => r.segment)).size;
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
    multiplier: mult.multiplier,
    readings: cleaned.map((r) => ({ a: r.algo, s: r.segment, b: +r.bpm.toFixed(2), c: +r.confidence.toFixed(2), w: +r.weight.toFixed(2) })),
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
