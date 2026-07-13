import { create } from "zustand";
import { analyzeFile, formatDuration } from "./audio/analyzer";
import { useLibraryStore, type Track } from "./library-store";
import { invalidateHarmonicCache } from "./harmonic";
import { invalidateSetCache } from "./setbuilder";
import { analysisNotification } from "./native/analysis-notification";

const CONCURRENCY = 2;
const MAX_LOG = 200;

export interface AnalysisLogEntry {
  id: string;
  title: string;
  ok: boolean;
  bpm: number | null;
  camelot: string | null;
  confidence: number | null;
  suspect: boolean;
  message?: string;
  at: number;
}

interface AnalysisState {
  running: boolean;
  total: number;
  done: number;
  errors: number;
  startedAt: number | null;
  currentIds: Set<string>;
  log: AnalysisLogEntry[];
  abort: boolean;
  force: boolean;
  scope: "pending" | "ids" | "all";
  scopeIds: Set<string>;

  start: () => Promise<void>;
  reanalyzeIds: (ids: string[]) => Promise<void>;
  reanalyzeAll: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

function applyAnalysisResult(
  trackId: string,
  res: Awaited<ReturnType<typeof analyzeFile>>,
) {
  const lib = useLibraryStore.getState().library;
  const t = lib?.tracks.find((x) => x.id === trackId);
  if (!t) return;
  const wasLockedBpm = t.bpmLocked === true && t.bpm != null;
  const wasLockedKey = t.keyLocked === true && t.camelot != null;

  const detected: NonNullable<Track["detected"]> = {
    bpm: res.bpm,
    key: res.key,
    camelot: res.camelot,
    bpmConfidence: res.bpmConfidence,
    keyConfidence: res.keyConfidence,
    suspect: res.suspect,
    detectedAt: res.analyzedAt,
  };

  const patch: Partial<Track> = {
    fileHash: res.fileHash,
    durationSec: res.durationSec,
    duration: formatDuration(res.durationSec),
    analyzed: true,
    status: "done",
    error: null,
    detected,
    suspect: res.suspect,
  };

  if (!wasLockedBpm) {
    patch.bpm = res.bpm;
    patch.bpmConfidence = res.bpmConfidence;
  }
  if (!wasLockedKey) {
    patch.key = res.key;
    patch.camelot = res.camelot;
    patch.keyConfidence = res.keyConfidence;
  }

  useLibraryStore.getState().updateTrack(trackId, patch);
}

async function runQueue(
  queue: Track[],
  setState: (p: Partial<AnalysisState>) => void,
  getState: () => AnalysisState,
  force: boolean,
) {
  let cursor = 0;
  const next = (): Track | null => {
    if (getState().abort) return null;
    if (cursor >= queue.length) return null;
    return queue[cursor++];
  };

  const worker = async () => {
    for (;;) {
      const track = next();
      if (!track) return;
      const file = useLibraryStore.getState().getFile(track.id);
      if (!file) continue;

      useLibraryStore.getState().updateTrack(track.id, { status: "analyzing" });
      setState({ currentIds: new Set([...getState().currentIds, track.id]) });

      try {
        const res = await analyzeFile(file, { force });
        applyAnalysisResult(track.id, res);
        pushLog({
          id: track.id,
          title: track.title,
          ok: true,
          bpm: res.bpm,
          camelot: res.camelot,
          confidence: res.bpmConfidence,
          suspect: res.suspect,
          at: Date.now(),
        });
        setState({ done: getState().done + 1 });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Erreur d'analyse";
        useLibraryStore.getState().updateTrack(track.id, {
          status: "error",
          error: message,
          analyzed: false,
        });
        pushLog({
          id: track.id,
          title: track.title,
          ok: false,
          bpm: null,
          camelot: null,
          confidence: null,
          suspect: true,
          message,
          at: Date.now(),
        });
        setState({ done: getState().done + 1, errors: getState().errors + 1 });
      } finally {
        const cur = new Set(getState().currentIds);
        cur.delete(track.id);
        setState({ currentIds: cur });
        invalidateHarmonicCache();
        invalidateSetCache();
        const st = getState();
        void analysisNotification.update(st.done, st.total, track.title);
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, queue.length) },
    () => worker(),
  );
  await Promise.all(workers);
}

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  running: false,
  total: 0,
  done: 0,
  errors: 0,
  startedAt: null,
  currentIds: new Set(),
  log: [],
  abort: false,
  force: false,
  scope: "pending",
  scopeIds: new Set(),

  start: async () => {
    if (get().running) return;
    const lib = useLibraryStore.getState().library;
    if (!lib) return;
    const queue = lib.tracks.filter(
      (t) => t.status === "pending" && !!useLibraryStore.getState().getFile(t.id),
    );
    if (queue.length === 0) return;
    set({
      running: true,
      total: queue.length,
      done: 0,
      errors: 0,
      startedAt: Date.now(),
      currentIds: new Set(),
      abort: false,
      force: false,
      scope: "pending",
      scopeIds: new Set(),
    });
    await analysisNotification.start(queue.length);
    await runQueue(queue, (p) => set(p), get, false);
    await useLibraryStore.getState().flush();
    const finalState = get();
    set({ running: false, currentIds: new Set() });
    if (finalState.abort) {
      await analysisNotification.cancel();
    } else if (finalState.errors > 0) {
      await analysisNotification.finish(
        false,
        `${finalState.errors} erreur(s) sur ${finalState.total} morceaux`,
      );
    } else {
      await analysisNotification.finish(true, "Bibliothèque prête");
    }
  },

  reanalyzeIds: async (ids: string[]) => {
    if (get().running) return;
    const lib = useLibraryStore.getState().library;
    if (!lib) return;
    const idSet = new Set(ids);
    const queue = lib.tracks.filter(
      (t) => idSet.has(t.id) && !!useLibraryStore.getState().getFile(t.id),
    );
    if (queue.length === 0) return;
    // Reset status so the UI shows progress; do NOT clear locked fields.
    for (const t of queue) {
      useLibraryStore.getState().updateTrack(t.id, { status: "pending", error: null });
    }
    set({
      running: true,
      total: queue.length,
      done: 0,
      errors: 0,
      startedAt: Date.now(),
      currentIds: new Set(),
      abort: false,
      force: true,
      scope: "ids",
      scopeIds: idSet,
    });
    await analysisNotification.start(queue.length, "Réanalyse en cours");
    await runQueue(queue, (p) => set(p), get, true);
    await useLibraryStore.getState().flush();
    const finalState = get();
    set({ running: false, currentIds: new Set() });
    if (finalState.abort) {
      await analysisNotification.cancel();
    } else if (finalState.errors > 0) {
      await analysisNotification.finish(
        false,
        `${finalState.errors} erreur(s) sur ${finalState.total} morceaux`,
      );
    } else {
      await analysisNotification.finish(true, "Réanalyse terminée");
    }
  },

  reanalyzeAll: async () => {
    const lib = useLibraryStore.getState().library;
    if (!lib) return;
    await get().reanalyzeIds(lib.tracks.map((t) => t.id));
  },

  stop: () => {
    set({ abort: true });
  },

  reset: () => {
    set({
      running: false,
      total: 0,
      done: 0,
      errors: 0,
      startedAt: null,
      currentIds: new Set(),
      log: [],
      abort: false,
    });
  },
}));

function pushLog(entry: AnalysisLogEntry) {
  const log = [entry, ...useAnalysisStore.getState().log];
  if (log.length > MAX_LOG) log.length = MAX_LOG;
  useAnalysisStore.setState({ log });
}

export function formatETA(state: AnalysisState): string {
  if (!state.running || state.done === 0 || !state.startedAt) return "—";
  const elapsed = (Date.now() - state.startedAt) / 1000;
  const perTrack = elapsed / state.done;
  const remaining = Math.max(0, state.total - state.done) * perTrack;
  if (!isFinite(remaining)) return "—";
  if (remaining < 60) return `${Math.ceil(remaining)} s`;
  const m = Math.floor(remaining / 60);
  const s = Math.ceil(remaining % 60);
  return `${m} min ${s.toString().padStart(2, "0")} s`;
}
