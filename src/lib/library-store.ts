import { create } from "zustand";
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";

export const AUDIO_EXTENSIONS = [
  "mp3",
  "wav",
  "flac",
  "aac",
  "m4a",
  "mp4",
  "ogg",
  "oga",
  "opus",
  "aiff",
  "aif",
  "wma",
  "webm",
] as const;
export type AudioExtension = (typeof AUDIO_EXTENSIONS)[number];

export type TrackStatus = "pending" | "analyzing" | "done" | "error";

export interface DetectedSnapshot {
  bpm: number | null;
  key: string | null;
  camelot: string | null;
  bpmConfidence: number | null;
  keyConfidence: number | null;
  suspect: boolean;
  detectedAt: number;
}

export interface Track {
  id: string;
  title: string;
  fileName: string;
  filePath: string;
  extension: string;
  size: number | null;
  fileHash: string | null;
  bpm: number | null;
  key: string | null;
  camelot: string | null;
  durationSec: number | null;
  duration: string | null;
  analyzed: boolean;
  status: TrackStatus;
  error?: string | null;
  // --- Reliability / corrections (all optional for backwards-compat) ---
  bpmConfidence?: number | null;
  keyConfidence?: number | null;
  bpmLocked?: boolean;
  keyLocked?: boolean;
  suspect?: boolean;
  detected?: DetectedSnapshot | null; // original auto-detected values
  correctedAt?: number | null;
}

export interface Library {
  id: string;
  name: string;
  createdAt: number;
  tracks: Track[];
}

interface LibraryMeta {
  id: string;
  name: string;
  createdAt: number;
  trackCount: number;
}

interface LibraryState {
  library: Library | null;
  lastLibraryMeta: LibraryMeta | null;
  hydrated: boolean;
  selectedIds: Set<string>;
  setLibrary: (lib: Library) => Promise<void>;
  hydrate: () => Promise<void>;
  restoreLast: () => Promise<boolean>;
  clearLibrary: () => Promise<void>;
  toggleSelected: (id: string) => void;
  clearSelection: () => void;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  removeTracks: (ids: string[]) => Promise<void>;
  flush: () => Promise<void>;
  // Transient (not persisted): file handles for the current import session.
  setFiles: (entries: Array<{ trackId: string; file: File }>) => void;
  getFile: (trackId: string) => File | undefined;
  clearFiles: () => void;
  fileMapVersion: number;
}

const IDB_LIBRARY_KEY = "tempokey:active-library";
const META_KEY = "tempokey:last-library-meta";

function isAudioFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  return !!ext && (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function getExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export interface ImportProgress {
  phase: "scan" | "build" | "store" | "done";
  scanned: number;
  total: number;
}

export async function buildLibraryFromFiles(
  files: File[],
  onProgress?: (p: ImportProgress) => void,
): Promise<{ library: Library; files: Array<{ trackId: string; file: File }> }> {
  const audio = files.filter((f) => isAudioFile(f.name));
  const total = audio.length;
  onProgress?.({ phase: "scan", scanned: 0, total });

  const tracks: Track[] = new Array(total);
  const fileEntries: Array<{ trackId: string; file: File }> = new Array(total);
  for (let i = 0; i < total; i++) {
    const f = audio[i];
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const id = `${i}-${path}`;
    tracks[i] = {
      id,
      title: stripExt(f.name),
      fileName: f.name,
      filePath: path,
      extension: getExt(f.name),
      size: typeof f.size === "number" ? f.size : null,
      fileHash: null,
      bpm: null,
      key: null,
      camelot: null,
      durationSec: null,
      duration: null,
      analyzed: false,
      status: "pending",
      error: null,
    };
    fileEntries[i] = { trackId: id, file: f };
    if (i % 200 === 0) onProgress?.({ phase: "scan", scanned: i + 1, total });
  }
  onProgress?.({ phase: "build", scanned: total, total });

  // Derive folder name from common root segment of webkitRelativePath
  const firstPath = tracks[0]?.filePath ?? "";
  const folderName =
    firstPath.includes("/") ? firstPath.split("/")[0] : "Dossier importé";

  const lib: Library = {
    id: `lib_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: folderName,
    createdAt: Date.now(),
    tracks,
  };
  onProgress?.({ phase: "done", scanned: total, total });
  return { library: lib, files: fileEntries };
}

function metaOf(lib: Library): LibraryMeta {
  return { id: lib.id, name: lib.name, createdAt: lib.createdAt, trackCount: lib.tracks.length };
}

function loadMetaSync(): LibraryMeta | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as LibraryMeta) : null;
  } catch {
    return null;
  }
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  library: null,
  lastLibraryMeta: null,
  hydrated: false,
  selectedIds: new Set(),
  fileMapVersion: 0,

  setLibrary: async (lib) => {
    const meta = metaOf(lib);
    try {
      await idbSet(IDB_LIBRARY_KEY, lib);
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } catch (e) {
      console.error("[tempokey] persist failed", e);
    }
    set({ library: lib, lastLibraryMeta: meta, selectedIds: new Set() });
  },

  hydrate: async () => {
    if (get().hydrated) return;
    const meta = loadMetaSync();
    try {
      const lib = (await idbGet(IDB_LIBRARY_KEY)) as Library | undefined;
      set({
        library: lib ?? null,
        lastLibraryMeta: meta ?? (lib ? metaOf(lib) : null),
        hydrated: true,
      });
    } catch {
      set({ lastLibraryMeta: meta, hydrated: true });
    }
  },

  restoreLast: async () => {
    try {
      const lib = (await idbGet(IDB_LIBRARY_KEY)) as Library | undefined;
      if (!lib) return false;
      set({ library: lib, lastLibraryMeta: metaOf(lib), selectedIds: new Set() });
      return true;
    } catch {
      return false;
    }
  },

  clearLibrary: async () => {
    try {
      await idbDel(IDB_LIBRARY_KEY);
      localStorage.removeItem(META_KEY);
    } catch {}
    fileMap.clear();
    set({ library: null, lastLibraryMeta: null, selectedIds: new Set(), fileMapVersion: get().fileMapVersion + 1 });
  },

  toggleSelected: (id) => {
    const next = new Set(get().selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selectedIds: next });
  },
  clearSelection: () => set({ selectedIds: new Set() }),

  removeTracks: async (ids) => {
    const lib = get().library;
    if (!lib || ids.length === 0) return;
    const set_ = new Set(ids);
    const tracks = lib.tracks.filter((t) => !set_.has(t.id));
    for (const id of ids) fileMap.delete(id);
    const nextLib: Library = { ...lib, tracks };
    const nextSel = new Set(get().selectedIds);
    for (const id of ids) nextSel.delete(id);
    set({ library: nextLib, selectedIds: nextSel, fileMapVersion: get().fileMapVersion + 1 });
    try {
      await idbSet(IDB_LIBRARY_KEY, nextLib);
      localStorage.setItem(META_KEY, JSON.stringify(metaOf(nextLib)));
    } catch {}
  },

  updateTrack: (id, patch) => {
    const lib = get().library;
    if (!lib) return;
    let changed = false;
    const tracks = lib.tracks.map((t) => {
      if (t.id !== id) return t;
      changed = true;
      return { ...t, ...patch };
    });
    if (!changed) return;
    const nextLib: Library = { ...lib, tracks };
    set({ library: nextLib });
    schedulePersist(nextLib);
  },

  flush: async () => {
    await flushNow(get().library);
  },

  setFiles: (entries) => {
    for (const { trackId, file } of entries) fileMap.set(trackId, file);
    set({ fileMapVersion: get().fileMapVersion + 1 });
  },
  getFile: (trackId) => fileMap.get(trackId),
  clearFiles: () => {
    fileMap.clear();
    set({ fileMapVersion: get().fileMapVersion + 1 });
  },
}));

// ---- Transient in-memory file handles (not persisted) ----
const fileMap = new Map<string, File>();

// ---- Debounced persistence of library updates during analysis ----
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLib: Library | null = null;

function schedulePersist(lib: Library) {
  pendingLib = lib;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const l = pendingLib;
    pendingLib = null;
    if (l) void idbSet(IDB_LIBRARY_KEY, l).catch(() => {});
  }, 800);
}

async function flushNow(lib: Library | null) {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const l = pendingLib ?? lib;
  pendingLib = null;
  if (l) {
    try {
      await idbSet(IDB_LIBRARY_KEY, l);
    } catch {}
  }
}