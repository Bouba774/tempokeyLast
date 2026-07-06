// Debug tool: runs every available BPM estimator on the same file and
// returns their outputs side-by-side. Used to prove the new engine is
// wired end-to-end and to compare candidates across algorithms.
//
// Usage in DevTools console (or `adb logcat` with `console.info` bridge):
//   const f = document.querySelector('input[type=file]').files[0];
//   await window.tempokeyDebugBpm(f);

import { getEssentia, freeVectors, type EssentiaVector } from "./essentia-engine";
import { estimateBPM, estimateBPMVampCompat } from "./bpm";
import { resampleTo44k, toMono, trimSilence, peakNormalize } from "./preprocess";
import { analyzeBpmFusion } from "./bpm-fusion";
import { hashFile } from "./hash";
import { getCachedAnalysis, CACHE_VERSION } from "./cache";

export interface BpmDebugReport {
  file: string;
  hash: string;
  cacheStore: string;
  cached: { bpm: number | null; analyzedAt: number } | null;
  engines: Record<string, unknown>;
  fusion: unknown;
}

let ctx: AudioContext | null = null;
function getCtx(): AudioContext {
  if (ctx) return ctx;
  const AC =
    (window.AudioContext as typeof AudioContext | undefined) ??
    ((window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AC) throw new Error("Web Audio API unavailable");
  ctx = new AC();
  return ctx;
}

export async function debugBpm(file: File): Promise<BpmDebugReport> {
  const hash = await hashFile(file);
  const cached = await getCachedAnalysis(hash);
  const buf = await file.arrayBuffer();
  const audio = await getCtx().decodeAudioData(buf.slice(0));
  const mono = toMono(audio);
  const { samples, sampleRate } = await resampleTo44k(mono, audio.sampleRate);
  const trimmed = trimSilence(samples, sampleRate);
  peakNormalize(trimmed);

  const engines: Record<string, unknown> = {};

  // Pure-JS estimators
  try {
    engines.pureJS_estimateBPM = estimateBPM(trimmed, sampleRate);
  } catch (e) {
    engines.pureJS_estimateBPM = { error: String(e) };
  }
  try {
    engines.vampCompat = estimateBPMVampCompat(trimmed, sampleRate);
  } catch (e) {
    engines.vampCompat = { error: String(e) };
  }

  // Essentia estimators
  const essentia = await getEssentia();
  engines.essentiaAvailable = !!essentia;
  if (essentia) {
    const arr = new Float32Array(trimmed.length);
    arr.set(trimmed);
    const vec = essentia.arrayToVector(arr);
    try {
      const r = essentia.RhythmExtractor2013(vec, 208, "multifeature", 40);
      engines.RhythmExtractor2013 = { bpm: r.bpm, confidence: r.confidence, ticks: r.ticks?.size?.() ?? 0 };
      freeVectors(r.ticks as EssentiaVector, r.estimates as EssentiaVector, r.bpmIntervals as EssentiaVector);
    } catch (e) {
      engines.RhythmExtractor2013 = { error: String(e) };
    }
    try {
      const p = essentia.PercivalBpmEstimator(vec, 1024, 2048, 128, 128, 210, 50, 44100);
      engines.PercivalBpmEstimator = { bpm: p.bpm };
    } catch (e) {
      engines.PercivalBpmEstimator = { error: String(e) };
    }
    try {
      const dyn = essentia as unknown as {
        TempoCNN?: (s: EssentiaVector) => { bpm?: number; tempo?: number; confidence?: number };
      };
      if (typeof dyn.TempoCNN === "function") {
        const t = dyn.TempoCNN(vec);
        engines.TempoCNN = { bpm: t.bpm ?? t.tempo ?? null, confidence: t.confidence ?? null };
      } else {
        engines.TempoCNN = { available: false };
      }
    } catch (e) {
      engines.TempoCNN = { error: String(e) };
    }
    freeVectors(vec);

    // Full fusion
    try {
      engines.analyzeBpmFusion = await analyzeBpmFusion(essentia, trimmed, sampleRate);
    } catch (e) {
      engines.analyzeBpmFusion = { error: String(e) };
    }
  }

  const report: BpmDebugReport = {
    file: file.name,
    hash: hash.slice(0, 16),
    cacheStore: CACHE_VERSION,
    cached: cached ? { bpm: cached.bpm, analyzedAt: cached.analyzedAt } : null,
    engines,
    fusion: engines.analyzeBpmFusion,
  };

  // eslint-disable-next-line no-console
  console.info("[tempokey/bpm-debug]", report);
  return report;
}

if (typeof window !== "undefined") {
  (window as unknown as { tempokeyDebugBpm?: typeof debugBpm }).tempokeyDebugBpm = debugBpm;
}