import { hashFile } from "./hash";
import { estimateBPM } from "./bpm";
import { estimateKey } from "./key";
import { toCamelot, camelotFor } from "./camelot";
import { getCachedAnalysis, setCachedAnalysis, type TrackAnalysis } from "./cache";
import {
  toMono as preToMono,
  resampleTo44k,
  peakNormalize,
  trimSilence,
  pickSegments,
} from "./preprocess";
import { getEssentia, freeVectors, type EssentiaInstance } from "./essentia-engine";
import { analyzeBpmFusion } from "./bpm-fusion";

let ctx: AudioContext | null = null;
function getCtx(): AudioContext {
  if (ctx) return ctx;
  const AC =
    (window.AudioContext as typeof AudioContext | undefined) ??
    ((window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AC) throw new Error("Web Audio API non disponible");
  ctx = new AC();
  return ctx;
}

function decode(ac: AudioContext, buf: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    try {
      const p = ac.decodeAudioData(buf, resolve, reject) as unknown as Promise<AudioBuffer> | undefined;
      if (p && typeof (p as Promise<AudioBuffer>).then === "function") {
        (p as Promise<AudioBuffer>).then(resolve, reject);
      }
    } catch (e) {
      reject(e);
    }
  });
}

function toMono(audio: AudioBuffer): Float32Array {
  return preToMono(audio);
}

export function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface AnalyzeOptions {
  force?: boolean; // bypass cache
}

// ---------------------------------------------------------------------------
// Essentia-powered analysis pipeline.
// ---------------------------------------------------------------------------

function humanKeyLabel(note: string, scale: "major" | "minor"): string {
  const cap = scale === "major" ? "Major" : "Minor";
  return `${note} ${cap}`;
}

function essentiaKey(
  essentia: EssentiaInstance,
  samples: Float32Array,
  sampleRate: number,
  profileType: "bgate" | "edma" | "edmm" | "temperley" | "krumhansl" = "edma",
): { note: string; scale: "major" | "minor"; strength: number } | null {
  const buf = new Float32Array(samples.length);
  buf.set(samples);
  const vec = essentia.arrayToVector(buf);
  try {
    const out = essentia.KeyExtractor(
      vec,
      true,        // averageDetuningCorrection
      4096,        // frameSize
      2048,        // hopSize (50 % overlap – more stable HPCP averaging)
      12,          // hpcpSize
      3500,        // maxFrequency
      60,          // maximumSpectralPeaks
      25,          // minFrequency
      0.2,         // pcpThreshold
      profileType, // profileType
      sampleRate,  // sampleRate
      0.0001,      // spectralPeaksThreshold
      440,         // tuningFrequency
      "cosine",    // weightType
      "hann",      // windowType
    );
    return { note: out.key, scale: out.scale, strength: out.strength };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[essentia] KeyExtractor failed:", e);
    return null;
  } finally {
    freeVectors(vec);
  }
}

interface KeyVoteEntry {
  note: string;
  scale: "major" | "minor";
  strength: number;
  weight: number;
}

/** Weighted vote across multiple segment-level key estimates. */
function voteKey(entries: KeyVoteEntry[]): { note: string; scale: "major" | "minor"; confidence: number } | null {
  if (entries.length === 0) return null;
  const bucket = new Map<string, { note: string; scale: "major" | "minor"; total: number; count: number }>();
  let totalWeight = 0;
  for (const e of entries) {
    const key = `${e.note}|${e.scale}`;
    const w = Math.max(0, e.weight) * Math.max(0.05, Math.min(1, e.strength));
    totalWeight += w;
    const prev = bucket.get(key);
    if (prev) {
      prev.total += w;
      prev.count += 1;
    } else {
      bucket.set(key, { note: e.note, scale: e.scale, total: w, count: 1 });
    }
  }
  if (totalWeight <= 0) return null;
  const ranked = Array.from(bucket.values()).sort((a, b) => b.total - a.total);
  const best = ranked[0];
  const runner = ranked[1];
  const margin = runner ? (best.total - runner.total) / best.total : 1;
  // Average per-segment strength contribution for the winner.
  const winnerEntries = entries.filter((e) => e.note === best.note && e.scale === best.scale);
  const avgStrength = winnerEntries.reduce((s, e) => s + e.strength, 0) / Math.max(1, winnerEntries.length);
  const confidence = Math.max(0, Math.min(1, 0.4 * avgStrength + 0.6 * margin + 0.1));
  return { note: best.note, scale: best.scale, confidence };
}

async function analyzeWithEssentia(
  essentia: EssentiaInstance,
  mono44k: Float32Array,
  sampleRate: number,
): Promise<{
  bpm: number;
  bpmConfidence: number;
  bpmCandidates: { bpm: number; score: number }[];
  keyNote: string;
  keyScale: "major" | "minor";
  keyConfidence: number;
} | null> {
  // -----------------------------------------------------------------------
  // BPM: multi-algorithm fusion (RhythmExtractor2013 + PercivalBpmEstimator
  // + LoopBpmEstimator when available + beat-interval estimator) computed
  // on the full track and on 4 representative segments. See bpm-fusion.ts.
  // -----------------------------------------------------------------------
  const fusion = await analyzeBpmFusion(essentia, mono44k, sampleRate);
  if (!fusion) return null;

  // -----------------------------------------------------------------------
  // Key: run KeyExtractor with three complementary key profiles
  // (edma for EDM/popular, bgate for contemporary, temperley as a neutral
  // baseline) on the full signal plus 4 representative segments, then
  // weighted-vote. Multi-profile fusion mirrors what MIK/Rekordbox do
  // internally and significantly reduces relative-major/minor confusions.
  // -----------------------------------------------------------------------
  const segments = pickSegments(mono44k, sampleRate, 30);
  const votes: KeyVoteEntry[] = [];
  const profiles: Array<{
    p: "bgate" | "edma" | "temperley";
    w: number;
  }> = [
    { p: "edma", w: 1.2 },
    { p: "bgate", w: 1.0 },
    { p: "temperley", w: 0.8 },
  ];
  for (const { p, w } of profiles) {
    await new Promise<void>((r) => setTimeout(r, 0));
    const full = essentiaKey(essentia, mono44k, sampleRate, p);
    if (full) {
      votes.push({
        note: full.note,
        scale: full.scale,
        strength: full.strength,
        weight: 2.0 * w,
      });
    }
  }
  for (const seg of segments) {
    await new Promise<void>((r) => setTimeout(r, 0));
    const k = essentiaKey(essentia, seg.samples, sampleRate, "edma");
    if (k) {
      votes.push({ note: k.note, scale: k.scale, strength: k.strength, weight: seg.weight });
    }
  }
  const voted = voteKey(votes);
  if (!voted) {
    return null;
  }

  return {
    bpm: Math.round(fusion.bpm * 100) / 100,
    bpmConfidence: fusion.confidence,
    bpmCandidates: fusion.candidates.map((c) => ({ bpm: c.bpm, score: c.score })),
    keyNote: voted.note,
    keyScale: voted.scale,
    keyConfidence: Math.round(voted.confidence * 100) / 100,
  };
}

function fallbackAnalysis(mono: Float32Array, sampleRate: number) {
  const bpmRes = estimateBPM(mono, sampleRate);
  const keyRes = estimateKey(mono, sampleRate);
  return { bpmRes, keyRes };
}

export async function analyzeFile(
  file: File,
  options: AnalyzeOptions = {},
): Promise<TrackAnalysis> {
  const fileHash = await hashFile(file);
  if (!options.force) {
    const cached = await getCachedAnalysis(fileHash);
    if (cached) return cached;
  }

  const buf = await file.arrayBuffer();
  const audio = await decode(getCtx(), buf);
  const monoRaw = preToMono(audio);

  // Preprocess: resample to 44.1 kHz, normalise peak, trim silence.
  await new Promise<void>((r) => setTimeout(r, 0));
  const { samples: mono44k, sampleRate: sr } = await resampleTo44k(monoRaw, audio.sampleRate);
  const trimmed = trimSilence(mono44k, sr);
  peakNormalize(trimmed);

  let bpm: number | null = null;
  let bpmConfidence: number | null = null;
  let bpmCandidates: TrackAnalysis["bpmCandidates"] = [];
  let keyLabel: string | null = null;
  let camelot: string | null = null;
  let keyConfidence: number | null = null;

  // Try Essentia first.
  let usedEssentia = false;
  try {
    const essentia = await getEssentia();
    if (essentia) {
      await new Promise<void>((r) => setTimeout(r, 0));
      const res = await analyzeWithEssentia(essentia, trimmed, sr);
      if (res) {
        bpm = res.bpm;
        bpmConfidence = res.bpmConfidence;
        keyLabel = humanKeyLabel(res.keyNote, res.keyScale);
        camelot = camelotFor(res.keyNote, res.keyScale);
        keyConfidence = res.keyConfidence;
        bpmCandidates = res.bpmCandidates.length
          ? res.bpmCandidates
          : [{ bpm: res.bpm, score: 1 }];
        usedEssentia = true;
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[analyzer] Essentia path failed, using pure-JS fallback:", e);
  }

  if (!usedEssentia) {
    // Pure-JS fallback (preserves backward compatibility).
    await new Promise<void>((r) => setTimeout(r, 0));
    const { bpmRes, keyRes } = fallbackAnalysis(trimmed, sr);
    bpm = bpmRes.bpm;
    bpmConfidence = bpmRes.confidence;
    bpmCandidates = bpmRes.candidates;
    keyLabel = keyRes?.label ?? null;
    keyConfidence = keyRes?.confidence ?? null;
    camelot = keyRes ? toCamelot(keyRes) : null;
  }

  const suspect =
    (bpmConfidence ?? 0) < 0.45 || (keyConfidence ?? 0) < 0.35 || bpm == null;

  const result: TrackAnalysis = {
    fileHash,
    bpm,
    bpmConfidence,
    bpmCandidates,
    key: keyLabel,
    keyConfidence,
    camelot,
    durationSec: audio.duration,
    suspect,
    analyzedAt: Date.now(),
  };
  await setCachedAnalysis(result);
  return result;
}
