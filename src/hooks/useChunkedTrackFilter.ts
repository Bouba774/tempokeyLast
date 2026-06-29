import { useEffect, useMemo, useState } from "react";
import type { Track } from "@/lib/library-store";
import {
  type LibraryFilters,
  parseQuery,
  trackPassesFilters,
} from "@/lib/library-filters";

const CHUNK_SIZE =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
    ? 140
    : 450;

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
        window.setTimeout(runChunk, 0);
        return;
      }

      if (!cancelled) setState({ tracks: next, pending: false });
    };

    const handle = window.setTimeout(runChunk, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [tracks, parsedQuery, filters]);

  return state;
}