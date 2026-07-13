import { useLibraryStore, type Track } from "./library-store";

// Reverse camelot → key label for manual edits.
// We mirror src/lib/audio/camelot.ts: 1A..12A = minor wheel, 1B..12B = major wheel.
const CAMELOT_TO_KEY: Record<string, { note: string; mode: "major" | "minor" }> = {
  "8B": { note: "C", mode: "major" },
  "9B": { note: "G", mode: "major" },
  "10B": { note: "D", mode: "major" },
  "11B": { note: "A", mode: "major" },
  "12B": { note: "E", mode: "major" },
  "1B": { note: "B", mode: "major" },
  "2B": { note: "F#", mode: "major" },
  "3B": { note: "C#", mode: "major" },
  "4B": { note: "G#", mode: "major" },
  "5B": { note: "D#", mode: "major" },
  "6B": { note: "A#", mode: "major" },
  "7B": { note: "F", mode: "major" },
  "8A": { note: "A", mode: "minor" },
  "9A": { note: "E", mode: "minor" },
  "10A": { note: "B", mode: "minor" },
  "11A": { note: "F#", mode: "minor" },
  "12A": { note: "C#", mode: "minor" },
  "1A": { note: "G#", mode: "minor" },
  "2A": { note: "D#", mode: "minor" },
  "3A": { note: "A#", mode: "minor" },
  "4A": { note: "F", mode: "minor" },
  "5A": { note: "C", mode: "minor" },
  "6A": { note: "G", mode: "minor" },
  "7A": { note: "D", mode: "minor" },
};

export const ALL_CAMELOT = Array.from({ length: 12 }, (_, i) => i + 1).flatMap(
  (n) => [`${n}A`, `${n}B`],
);

export function camelotToKeyLabel(code: string): string | null {
  const v = CAMELOT_TO_KEY[code.toUpperCase()];
  return v ? `${v.note} ${v.mode}` : null;
}

function captureDetectedIfMissing(t: Track): NonNullable<Track["detected"]> {
  if (t.detected) return t.detected;
  return {
    bpm: t.bpm,
    key: t.key,
    camelot: t.camelot,
    bpmConfidence: t.bpmConfidence ?? null,
    keyConfidence: t.keyConfidence ?? null,
    suspect: t.suspect ?? false,
    detectedAt: Date.now(),
  };
}

export function setManualBpm(trackId: string, bpm: number, lock = true) {
  const lib = useLibraryStore.getState().library;
  const t = lib?.tracks.find((x) => x.id === trackId);
  if (!t) return;
  const detected = captureDetectedIfMissing(t);
  useLibraryStore.getState().updateTrack(trackId, {
    bpm: Math.round(bpm * 10) / 10,
    bpmConfidence: 1,
    bpmLocked: lock,
    detected,
    correctedAt: Date.now(),
  });
}

export function multiplyBpm(trackId: string, factor: number) {
  const lib = useLibraryStore.getState().library;
  const t = lib?.tracks.find((x) => x.id === trackId);
  if (!t || t.bpm == null) return;
  setManualBpm(trackId, t.bpm * factor, true);
}

export function setManualCamelot(trackId: string, code: string, lock = true) {
  const lib = useLibraryStore.getState().library;
  const t = lib?.tracks.find((x) => x.id === trackId);
  if (!t) return;
  const key = camelotToKeyLabel(code);
  if (!key) return;
  const detected = captureDetectedIfMissing(t);
  useLibraryStore.getState().updateTrack(trackId, {
    camelot: code.toUpperCase(),
    key,
    keyConfidence: 1,
    keyLocked: lock,
    detected,
    correctedAt: Date.now(),
  });
}

export function lockBpm(trackId: string, locked: boolean) {
  useLibraryStore.getState().updateTrack(trackId, { bpmLocked: locked });
}

export function lockKey(trackId: string, locked: boolean) {
  useLibraryStore.getState().updateTrack(trackId, { keyLocked: locked });
}

export function restoreDetectedBpm(trackId: string) {
  const lib = useLibraryStore.getState().library;
  const t = lib?.tracks.find((x) => x.id === trackId);
  if (!t || !t.detected) return;
  useLibraryStore.getState().updateTrack(trackId, {
    bpm: t.detected.bpm,
    bpmConfidence: t.detected.bpmConfidence,
    bpmLocked: false,
    correctedAt: Date.now(),
  });
}

export function restoreDetectedKey(trackId: string) {
  const lib = useLibraryStore.getState().library;
  const t = lib?.tracks.find((x) => x.id === trackId);
  if (!t || !t.detected) return;
  useLibraryStore.getState().updateTrack(trackId, {
    camelot: t.detected.camelot,
    key: t.detected.key,
    keyConfidence: t.detected.keyConfidence,
    keyLocked: false,
    correctedAt: Date.now(),
  });
}

export type ConfidenceLabel = "high" | "good" | "low" | "weak" | "none";

export function confidenceLabel(c: number | null | undefined): ConfidenceLabel {
  if (c == null) return "none";
  if (c >= 0.85) return "high";
  if (c >= 0.65) return "good";
  if (c >= 0.45) return "low";
  return "weak";
}

export function confidenceText(label: ConfidenceLabel): string {
  switch (label) {
    case "high": return "Très fiable";
    case "good": return "Fiable";
    case "low": return "À vérifier";
    case "weak": return "Faible confiance";
    default: return "—";
  }
}

/** Tailwind classes (text + bg) for a confidence dot/pill. */
export function confidenceTone(label: ConfidenceLabel): {
  text: string;
  bg: string;
  ring: string;
} {
  switch (label) {
    case "high":
      return { text: "text-emerald-300", bg: "bg-emerald-500/15", ring: "ring-emerald-500/30" };
    case "good":
      return { text: "text-sky-300", bg: "bg-sky-500/15", ring: "ring-sky-500/30" };
    case "low":
      return { text: "text-amber-300", bg: "bg-amber-500/15", ring: "ring-amber-500/30" };
    case "weak":
      return { text: "text-red-300", bg: "bg-red-500/15", ring: "ring-red-500/30" };
    default:
      return { text: "text-muted-foreground", bg: "bg-[var(--surface-elevated)]", ring: "ring-border" };
  }
}
