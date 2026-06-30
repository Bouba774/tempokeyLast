import { useEffect, useMemo, useState } from "react";
import type { Track } from "@/lib/library-store";
import {
  type LibraryFilters,
  parseQuery,
  trackPassesFilters,
} from "@/lib/library-filters";

const CHUNK_SIZE =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
    ? 64
    : 450;

type ScheduledHandle =
  | { type: "idle"; id: number }
  | { type: "timeout"; id: number };

function scheduleChunk(callback: () => void): ScheduledHandle {
  if (
    typeof window !== "undefined" &&
    "requestIdleCallback" in window &&
    typeof window.requestIdleCallback === "function"
  ) {
    const id = window.requestIdleCallback(callback, { timeout: 90 });
    return { type: "idle", id };
  }
  return { type: "timeout", id: window.setTimeout(callback, 16) };
}

function cancelScheduled(handle: ScheduledHandle | null): void {
  if (!handle || typeof window === "undefined") return;
  if (handle.type === "idle" && typeof window.cancelIdleCallback === "function") {
    window.cancelIdleCallback(handle.id);
    return;
  }
  window.clearTimeout(handle.id);
}

type FilterState = {
  tracks: Track[];
  pending: boolean;
};

/**
 * Filters large libraries without monopolising the Android WebView main thread.
 * Desktop Chrome tolerates one synchronous pass, but Android System WebView can
 * appear frozen when the pass happens during tap/focus/keyboard work.
 */
export function useChunkedTrackFilter(
  tracks: Track[],
  query: string,
  filters: LibraryFilters,
): FilterState {
  const parsedQuery = useMemo(() => parseQuery(query), [query]);
  const [state, setState] = useState<FilterState>({ tracks, pending: false });

  useEffect(() => {
    let cancelled = false;
    let index = 0;
    let scheduled: ScheduledHandle | null = null;
    const next: Track[] = [];

    setState((prev) => ({ tracks: prev.tracks, pending: true }));

    const runChunk = () => {
      if (cancelled) return;
      const end = Math.min(index + CHUNK_SIZE, tracks.length);
      for (; index < end; index++) {
        const track = tracks[index];
        if (trackPassesFilters(track, parsedQuery, filters)) next.push(track);
      }

      if (index < tracks.length) {
        scheduled = scheduleChunk(runChunk);
        return;
      }

      if (!cancelled) setState({ tracks: next, pending: false });
    };

    scheduled = scheduleChunk(runChunk);
    return () => {
      cancelled = true;
      cancelScheduled(scheduled);
    };
  }, [tracks, parsedQuery, filters]);

  return state;
}