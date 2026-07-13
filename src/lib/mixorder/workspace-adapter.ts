/**
 * MixOrder workspace adapter.
 *
 * Bridges the imported MixOrder analysis logic (which was authored against
 * its own `workspace-context.tsx`) onto TempoKey's canonical stores:
 *
 *   - Library:        `useLibraryStore` (single source of truth)
 *   - Ordering:       `useOrderingStore`
 *   - File handles:   `useLibraryStore.getFile` / `setFiles`
 *
 * MixOrder algorithms are NOT modified. Only the Track shape / actions they
 * see are re-mapped here so there is exactly one library, one model, one
 * cache and one preference layer across TempoKey and MixOrder.
 */
import { useMemo, useCallback } from "react";
import { Capacitor } from "@capacitor/core";
import {
  useLibraryStore,
  type Track as TkTrack,
} from "@/lib/library-store";

export type TrackId = string;

/** MixOrder-shaped track, projected from a TempoKey library track. */
export interface Track {
  id: TrackId;
  name: string;
  originalName: string;
  path: string;
  extension: string;
  size: number;
  mimeType: string;
  url: string;
  file?: File;
  durationSec: number | null;
  bpm: number | null;
  musicalKey: string | null;
}

export interface Project {
  name: string;
  createdAt: number;
  tracks: Track[];
}

const MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  wma: "audio/x-ms-wma",
  webm: "audio/webm",
};

/** Project a TempoKey track into the MixOrder Track shape (no new fields
 *  are invented — the id stays identical so writes round-trip). */
export function toMixOrderTrack(t: TkTrack, file?: File): Track {
  const ext = t.extension?.toLowerCase() ?? "";
  const mime = file?.type || MIME_BY_EXT[ext] || "application/octet-stream";
  let url = "";
  if (file) {
    try {
      url = URL.createObjectURL(file);
    } catch {
      url = "";
    }
  } else if (t.filePath && Capacitor.isNativePlatform()) {
    try {
      url = Capacitor.convertFileSrc(t.filePath);
    } catch {
      url = "";
    }
  }
  return {
    id: t.id,
    name: t.title,
    originalName: t.fileName,
    path: t.filePath,
    extension: ext,
    size: t.size ?? 0,
    mimeType: mime,
    url,
    file,
    durationSec: t.durationSec ?? null,
    bpm: t.bpm ?? null,
    musicalKey: t.key ?? null,
  };
}

export interface UseWorkspaceValue {
  project: Project | null;
  isIndexing: boolean;
  updateTrack: (
    id: TrackId,
    patch: Partial<Omit<Track, "id" | "file">>,
  ) => void;
  setTrackAnalysis: (
    id: TrackId,
    patch: { bpm?: number | null; musicalKey?: string | null },
    source: string,
  ) => void;
  removeTracks: (ids: TrackId[]) => void;
  reorderTracks: (orderedIds: TrackId[]) => void;
  /** Kept for API compatibility with the original MixOrder context. */
  closeProject: () => void;
}

/** MixOrder-shaped hook, backed by TempoKey stores. */
export function useWorkspace(): UseWorkspaceValue {
  const library = useLibraryStore((s) => s.library);
  const fileMapVersion = useLibraryStore((s) => s.fileMapVersion);
  const getFile = useLibraryStore((s) => s.getFile);
  const tkUpdate = useLibraryStore((s) => s.updateTrack);
  const tkRemove = useLibraryStore((s) => s.removeTracks);
  const tkClear = useLibraryStore((s) => s.clearLibrary);
  const setLibrary = useLibraryStore((s) => s.setLibrary);

  const project = useMemo<Project | null>(() => {
    if (!library) return null;
    return {
      name: library.name,
      createdAt: library.createdAt,
      tracks: library.tracks.map((t) => toMixOrderTrack(t, getFile(t.id))),
    };
    // fileMapVersion invalidates URLs when file handles change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, fileMapVersion, getFile]);

  const updateTrack = useCallback<UseWorkspaceValue["updateTrack"]>(
    (id, patch) => {
      const tk: Partial<TkTrack> = {};
      if (patch.name !== undefined) tk.title = patch.name;
      if (patch.originalName !== undefined) tk.fileName = patch.originalName;
      if (patch.path !== undefined) tk.filePath = patch.path;
      if (patch.extension !== undefined) tk.extension = patch.extension;
      if (patch.size !== undefined) tk.size = patch.size;
      if (patch.durationSec !== undefined) tk.durationSec = patch.durationSec;
      if (patch.bpm !== undefined) tk.bpm = patch.bpm;
      if (patch.musicalKey !== undefined) tk.key = patch.musicalKey;
      if (Object.keys(tk).length > 0) tkUpdate(id, tk);
    },
    [tkUpdate],
  );

  const setTrackAnalysis = useCallback<UseWorkspaceValue["setTrackAnalysis"]>(
    (id, patch /* source */) => {
      const tk: Partial<TkTrack> = {};
      if (patch.bpm !== undefined) tk.bpm = patch.bpm;
      if (patch.musicalKey !== undefined) tk.key = patch.musicalKey;
      if (Object.keys(tk).length > 0) tkUpdate(id, tk);
    },
    [tkUpdate],
  );

  const removeTracks = useCallback(
    (ids: TrackId[]) => {
      void tkRemove(ids);
    },
    [tkRemove],
  );

  const reorderTracks = useCallback(
    (orderedIds: TrackId[]) => {
      const lib = useLibraryStore.getState().library;
      if (!lib) return;
      const byId = new Map(lib.tracks.map((t) => [t.id, t]));
      const next: TkTrack[] = [];
      for (const id of orderedIds) {
        const t = byId.get(id);
        if (t) {
          next.push(t);
          byId.delete(id);
        }
      }
      for (const t of byId.values()) next.push(t);
      void setLibrary({ ...lib, tracks: next });
    },
    [setLibrary],
  );

  const closeProject = useCallback(() => {
    void tkClear();
  }, [tkClear]);

  return {
    project,
    isIndexing: false,
    updateTrack,
    setTrackAnalysis,
    removeTracks,
    reorderTracks,
    closeProject,
  };
}

export function formatDuration(sec: number | null): string {
  if (sec === null || !isFinite(sec)) return "—:—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}