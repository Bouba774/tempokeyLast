// Advanced BPM estimation inspired by the algorithms used in Mixxx /
// Rekordbox / VirtualDJ:
//   1. Compute a log-magnitude STFT and derive a multi-band spectral
//      flux onset detection function (ODF). Spectral flux captures
//      percussive transients far better than the previous RMS envelope.
//   2. Build a tempogram by autocorrelating the ODF, then refine the
//      candidate tempi with a 4-harmonic comb filter (the trick used by
//      most modern beat trackers to disambiguate half / double tempo).
//   3. Resolve the final BPM by selecting the octave whose comb score
//      is the strongest inside the DJ-friendly tempo window.
//
// The output is intentionally compatible with the previous BpmEstimate
// shape so the rest of the app keeps working unchanged.
import { fftInPlace } from "./fft";

const FFT_SIZE = 1024;
const HOP = 512;            // ≈ 11.6 ms @ 44.1 kHz → ODF rate ≈ 86 Hz
const MIN_BPM = 60;
const MAX_BPM = 200;
// Preferred DJ tempo window — used to resolve half / double tempo ties.
const DJ_PREF_MIN = 85;
const DJ_PREF_MAX = 175;

export interface BpmCandidate {
  bpm: number;
  score: number; // normalized 0..1
}

export interface BpmEstimate {
  bpm: number | null;
  confidence: number; // 0..1
  candidates: BpmCandidate[]; // top alternates, sorted by score desc
  suspect: boolean; // true when result is ambiguous
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}
const WINDOW = hann(FFT_SIZE);

// Build a band-weighted spectral-flux onset detection function.
// We emphasise the low/low-mid band (≈ 30–250 Hz, where the kick lives)
// and the high band (≈ 4–10 kHz, hats / claps) which together capture
// the rhythmic skeleton of most contemporary productions.
function computeOnsetEnvelope(samples: Float32Array, sampleRate: number): {
  odf: Float32Array;
  rate: number;
} {
  // Analyse a ~90 s window centred on the middle of the track. The
  // FFT-based autocorrelation below stays well under 30 ms even at this
  // length, so we get the extra robustness for free.
  const targetLen = Math.min(samples.length, Math.floor(sampleRate * 90));
  const offset = Math.max(0, Math.floor((samples.length - targetLen) / 2));
  const frames = Math.max(0, Math.floor((targetLen - FFT_SIZE) / HOP));
  if (frames < 64) return { odf: new Float32Array(0), rate: sampleRate / HOP };

  const binHz = sampleRate / FFT_SIZE;
  const bandEdges = [30, 120, 250, 500, 1000, 2000, 4000, 8000, 12000];
  const bandWeights = [1.4, 1.3, 1.0, 0.6, 0.5, 0.5, 0.9, 1.1]; // emphasise kick + hats
  const bandBins: { lo: number; hi: number; w: number }[] = [];
  for (let i = 0; i < bandEdges.length - 1; i++) {
    const lo = Math.max(1, Math.floor(bandEdges[i] / binHz));
    const hi = Math.min(FFT_SIZE / 2, Math.ceil(bandEdges[i + 1] / binHz));
    if (hi > lo) bandBins.push({ lo, hi, w: bandWeights[i] });
  }

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const prevMag = bandBins.map(() => new Float32Array(0));
  for (let b = 0; b < bandBins.length; b++) {
    prevMag[b] = new Float32Array(bandBins[b].hi - bandBins[b].lo);
  }

  const odf = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = offset + f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[start + i] * WINDOW[i];
      im[i] = 0;
    }
    fftInPlace(re, im);

    let flux = 0;
    for (let b = 0; b < bandBins.length; b++) {
      const { lo, hi, w } = bandBins[b];
      const prev = prevMag[b];
      let bandFlux = 0;
      for (let k = lo; k < hi; k++) {
        const mag = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        const d = mag - prev[k - lo];
        if (d > 0) bandFlux += d;
        prev[k - lo] = mag;
      }
      flux += w * bandFlux;
    }
    odf[f] = flux;
  }

  // Adaptive subtraction of a moving-median baseline to suppress drone /
  // sustained energy and keep only true onsets.
  const halfWin = 8;
  const smoothed = new Float32Array(frames);
  const buf: number[] = [];
  for (let i = 0; i < frames; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(frames - 1, i + halfWin);
    buf.length = 0;
    for (let j = lo; j <= hi; j++) buf.push(odf[j]);
    buf.sort((a, b) => a - b);
    const median = buf[Math.floor(buf.length / 2)];
    const v = odf[i] - 1.1 * median;
    smoothed[i] = v > 0 ? v : 0;
  }
  return { odf: smoothed, rate: sampleRate / HOP };
}

interface Peak { lag: number; score: number }

function findPeaks(acf: Float32Array, minLag: number, maxLag: number): Peak[] {
  const peaks: Peak[] = [];
  let max = 0;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (acf[lag] > acf[lag - 1] && acf[lag] >= acf[lag + 1] && acf[lag] > 0) {
      peaks.push({ lag, score: acf[lag] });
      if (acf[lag] > max) max = acf[lag];
    }
  }
  if (max <= 0) return [];
  for (const p of peaks) p.score /= max;
  peaks.sort((a, b) => b.score - a.score);
  return peaks;
}

function refineLag(acf: Float32Array, lag: number, minLag: number, maxLag: number): number {
  if (lag <= minLag || lag >= maxLag) return lag;
  const y0 = acf[lag - 1];
  const y1 = acf[lag];
  const y2 = acf[lag + 1];
  const denom = y0 - 2 * y1 + y2;
  if (denom === 0) return lag;
  const delta = (0.5 * (y0 - y2)) / denom;
  if (delta <= -1 || delta >= 1) return lag;
  return lag + delta;
}

export function estimateBPM(samples: Float32Array, sampleRate: number): BpmEstimate {
  const empty: BpmEstimate = { bpm: null, confidence: 0, candidates: [], suspect: true };
  if (samples.length < sampleRate * 5) return empty;

  const { odf, rate } = computeOnsetEnvelope(samples, sampleRate);
  if (odf.length < 256) return empty;

  // Zero-mean for cleaner autocorrelation.
  let mean = 0;
  for (let i = 0; i < odf.length; i++) mean += odf[i];
  mean /= odf.length;
  for (let i = 0; i < odf.length; i++) odf[i] -= mean;

  const minLag = Math.max(2, Math.floor((60 * rate) / MAX_BPM));
  const maxLag = Math.min(odf.length - 1, Math.floor((60 * rate) / MIN_BPM));

  // FFT-based autocorrelation (Wiener-Khinchin theorem). This is exactly
  // the path taken by the Vamp FixedTempoEstimator plugin used by DiscDJ
  // and lets us analyse a longer window without slowing the import down.
  let nfft = 1;
  while (nfft < odf.length * 2) nfft <<= 1;
  const re = new Float32Array(nfft);
  const im = new Float32Array(nfft);
  for (let i = 0; i < odf.length; i++) re[i] = odf[i];
  fftInPlace(re, im);
  for (let i = 0; i < nfft; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  // Inverse FFT via conjugation trick.
  for (let i = 0; i < nfft; i++) im[i] = -im[i];
  fftInPlace(re, im);
  const invN = 1 / nfft;
  const acf = new Float32Array(maxLag + 1);
  let acfMax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    // Unbiased estimate: normalize by the number of overlapping samples.
    const overlap = odf.length - lag;
    const v = overlap > 0 ? (re[lag] * invN) / overlap : 0;
    acf[lag] = v;
    if (v > acfMax) acfMax = v;
  }
  if (acfMax <= 0) return empty;

  // Comb-filter score: a real beat at period L should also have energy at
  // 2L, 3L, 4L → sum acf[k*L] with decaying weights. This is the same
  // trick that lets Mixxx / Rekordbox lock onto the right octave.
  const combWeights = [1.0, 0.8, 0.6, 0.45];
  const bpmFromLag = (lag: number) => (60 * rate) / lag;

  const candidates: { bpm: number; lag: number; score: number }[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (acf[lag] <= 0) continue;
    let s = 0;
    for (let h = 0; h < combWeights.length; h++) {
      const l = lag * (h + 1);
      if (l > maxLag) break;
      s += combWeights[h] * Math.max(0, acf[l]);
    }
    const bpm = bpmFromLag(lag);
    if (bpm < MIN_BPM || bpm > MAX_BPM) continue;
    // Log-Gaussian tempo prior centred at 120 BPM — the exact bias used
    // by the Vamp FixedTempoEstimator plugin shipped with DiscDJ. It is
    // symmetric in the half/double-tempo sense (a track at 60 and one at
    // 240 BPM are pulled toward 120 with the same strength).
    const logDist = Math.log(bpm / 120);
    const prior = Math.exp(-0.5 * (logDist / 0.55) * (logDist / 0.55));
    const inside = bpm >= DJ_PREF_MIN && bpm <= DJ_PREF_MAX ? 1.0 : 0.75;
    candidates.push({ bpm, lag, score: s * prior * inside });
  }
  if (candidates.length === 0) return empty;
  candidates.sort((a, b) => b.score - a.score);

  // Pick the best comb candidate; refine lag with parabolic interpolation.
  const best = candidates[0];
  const refined = refineLag(acf, best.lag, minLag, maxLag);
  let chosen = bpmFromLag(refined);

  // Octave snap: if exactly half/double is still inside the DJ window with a
  // comparable raw acf score, prefer that. Handles tracks where the
  // strongest periodicity is at the half-bar.
  const variants = [chosen, chosen * 2, chosen / 2];
  let bestVar = chosen;
  let bestVarScore = -Infinity;
  for (const b of variants) {
    if (b < MIN_BPM || b > MAX_BPM) continue;
    const logDist = Math.log(b / 120);
    const prior = Math.exp(-0.5 * (logDist / 0.55) * (logDist / 0.55));
    const inside = b >= DJ_PREF_MIN && b <= DJ_PREF_MAX ? 1.0 : 0.75;
    // Reuse the comb score of the nearest lag.
    const lag = Math.max(minLag, Math.min(maxLag, Math.round((60 * rate) / b)));
    let s = 0;
    for (let h = 0; h < combWeights.length; h++) {
      const l = lag * (h + 1);
      if (l > maxLag) break;
      s += combWeights[h] * Math.max(0, acf[l]);
    }
    const score = s * prior * inside;
    if (score > bestVarScore) {
      bestVarScore = score;
      bestVar = b;
    }
  }
  chosen = bestVar;

  // Top alternates for the UI (deduplicated, including the two octaves).
  const altSeen = new Set<number>();
  const alts: BpmCandidate[] = [];
  for (const c of candidates.slice(0, 6)) {
    for (const b of [c.bpm, c.bpm * 2, c.bpm / 2]) {
      if (b < MIN_BPM || b > MAX_BPM) continue;
      const r = Math.round(b * 10) / 10;
      if (altSeen.has(r)) continue;
      altSeen.add(r);
      alts.push({ bpm: r, score: c.score / candidates[0].score });
    }
  }

  // Confidence: separation between top and runner-up that is NOT an octave.
  const runner = candidates.find((c) => {
    if (c === best) return false;
    const r1 = c.bpm / best.bpm;
    const r2 = best.bpm / c.bpm;
    for (const r of [r1, r2]) {
      if (Math.abs(r - 2) < 0.06) return false;
      if (Math.abs(r - 0.5) < 0.06) return false;
      if (Math.abs(r - 3) < 0.06) return false;
      if (Math.abs(r - 1 / 3) < 0.06) return false;
    }
    return true;
  });
  const ratio = runner ? (best.score - runner.score) / best.score : 1;
  let confidence = Math.max(0, Math.min(1, ratio * 1.8 + 0.35));
  if (chosen >= DJ_PREF_MIN && chosen <= DJ_PREF_MAX) confidence = Math.min(1, confidence + 0.1);
  // Comb response sharpness as additional signal.
  const sharp = best.score / (candidates[Math.min(5, candidates.length - 1)].score || 1);
  confidence = Math.min(1, confidence + Math.min(0.15, (sharp - 1) * 0.05));

  const suspect = confidence < 0.45;

  return {
    bpm: Math.round(chosen * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    candidates: alts.slice(0, 5),
    suspect,
  };
}
