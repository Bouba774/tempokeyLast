import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Search,
  SlidersHorizontal,
  Check,
  Loader2,
  AlertTriangle,
  GripVertical,
  Play,
  Pause,
  Info,
  Lock,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { usePlayerStore } from "@/lib/audio/player-store";
import { useLibraryStore, type Track } from "@/lib/library-store";
import { useOrderingStore, useOrderedTracks } from "@/lib/ordering-store";
import { useAnalysisStore } from "@/lib/analysis-store";
import { FilterSheet } from "./FilterSheet";
import { TrackDetailSheet } from "./TrackDetailSheet";
import { CamelotBadge } from "./viz/CamelotBadge";
import { EnergyMeter } from "./viz/EnergyMeter";
import { CompatibilityBadge } from "./viz/CompatibilityBadge";
import { EmptyState } from "./ui/empty-state";
import { useBackHandler } from "@/hooks/useBackHandler";
import { NowPlayingBars } from "./ui/now-playing-bars";
import { Music2, SearchX } from "lucide-react";
import {
  confidenceLabel,
  confidenceTone,
} from "@/lib/corrections";
import {
  DEFAULT_FILTERS,
  type LibraryFilters,
  filtersActiveCount,
} from "@/lib/library-filters";
import { useChunkedTrackFilter } from "@/hooks/useChunkedTrackFilter";

function TrackRow({
  track,
  index,
  selected,
  onToggle,
  onOpenDetails,
  reorderMode,
  compareTo,
  dragHandleProps,
  isDragging,
}: {
  track: Track;
  index: number;
  selected: boolean;
  onToggle: () => void;
  onOpenDetails: () => void;
  reorderMode: boolean;
  compareTo: Track | null;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement> & Record<string, unknown>;
  isDragging?: boolean;
}) {
  const isCurrent = usePlayerStore((s) => s.currentId === track.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying && s.currentId === track.id);
  const play = usePlayerStore((s) => s.play);
  const toggle = usePlayerStore((s) => s.toggle);

  // Overall row confidence = min of bpm/key, only when analyzed.
  const conf =
    track.analyzed && (track.bpmConfidence != null || track.keyConfidence != null)
      ? Math.min(
          track.bpmConfidence ?? 1,
          track.keyConfidence ?? 1,
        )
      : null;
  const tone = confidenceTone(confidenceLabel(conf));
  const suspect = track.suspect === true;

  return (
    <div
      className={`group flex w-full items-center gap-2 rounded-xl border px-3 py-3 text-left transition-colors ${
        isDragging
          ? "border-[var(--primary)] bg-[var(--primary)]/15 shadow-lg shadow-[var(--primary)]/20"
          : isCurrent
          ? "border-[var(--primary)]/60 bg-[var(--primary)]/5"
          : selected
            ? "border-[var(--primary)] bg-[var(--primary)]/10"
            : "border-border bg-card hover:bg-accent"
      }`}
    >
      {!reorderMode && (
        <button
          aria-label={isPlaying ? "Pause" : "Pré-écouter"}
          onClick={(e) => {
            e.stopPropagation();
            if (isCurrent) toggle();
            else void play(track);
          }}
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition-transform active:scale-95 ${
            isCurrent
              ? "text-[var(--primary-foreground)]"
              : "bg-[var(--surface-elevated)] text-[var(--primary-glow)] hover:bg-[var(--primary)]/20"
          }`}
          style={
            isCurrent ? { background: "var(--gradient-primary)" } : undefined
          }
        >
          {isPlaying ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4 translate-x-[1px]" />
          )}
        </button>
      )}
      {reorderMode && (
        <button
          type="button"
          aria-label="Glisser pour réorganiser"
          {...(dragHandleProps ?? {})}
          onClick={(e) => e.preventDefault()}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--surface-elevated)] text-[var(--primary-glow)] touch-none cursor-grab active:cursor-grabbing"
          style={{ touchAction: "none" }}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      <button
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        {reorderMode && (
          <div
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[10px] font-semibold uppercase tabular-nums ${
              selected
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "bg-[var(--surface-elevated)] text-[var(--primary-glow)]"
            }`}
          >
            {selected ? (
              <Check className="h-4 w-4" />
            ) : track.status === "analyzing" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : track.status === "error" ? (
              <AlertTriangle className="h-4 w-4 text-[var(--destructive,#ef4444)]" />
            ) : (
              <span className="tabular-nums">{index + 1}</span>
            )}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
            {isCurrent && <NowPlayingBars playing={isPlaying} className="shrink-0" />}
            {selected && !reorderMode && !isCurrent && (
              <Check className="inline h-3.5 w-3.5 shrink-0 text-[var(--primary-glow)]" />
            )}
            {conf != null && !isCurrent && (
              <span
                aria-label="Niveau de confiance"
                title="Niveau de confiance"
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone.text}`}
                style={{ background: "currentColor" }}
              />
            )}
            <span className="truncate">{track.title}</span>
            {suspect && (
              <AlertTriangle
                aria-label="À vérifier"
                className="h-3 w-3 shrink-0 text-amber-400"
              />
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
            <CamelotBadge code={track.camelot} size="xs" />
            <span className="inline-flex items-center gap-0.5">
              {track.bpm ?? "—"} BPM
              {track.bpmLocked && <Lock className="h-2.5 w-2.5" />}
            </span>
            <EnergyMeter track={track} />
            <span className="text-border">·</span>
            <span>{track.duration ?? "—"}</span>
            {compareTo && compareTo.id !== track.id && (
              <CompatibilityBadge source={compareTo} target={track} compact />
            )}
          </div>
        </div>
      </button>
      {!reorderMode && (
        <button
          aria-label="Détails"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDetails();
          }}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-[var(--surface-elevated)] hover:text-foreground"
        >
          <Info className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function SortableTrackRow(props: {
  track: Track;
  index: number;
  selected: boolean;
  onToggle: () => void;
  onOpenDetails: () => void;
  reorderMode: boolean;
  compareTo: Track | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.track.id, disabled: !props.reorderMode });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <TrackRow
        {...props}
        isDragging={isDragging}
        dragHandleProps={
          props.reorderMode
            ? { ...(attributes as unknown as Record<string, unknown>), ...((listeners ?? {}) as unknown as Record<string, unknown>) }
            : undefined
        }
      />
    </div>
  );
}

export function TrackList() {
  const selectedIds = useLibraryStore((s) => s.selectedIds);
  const toggle = useLibraryStore((s) => s.toggleSelected);
  const clear = useLibraryStore((s) => s.clearSelection);
  const orderedLive = useOrderedTracks();
  const active = useOrderingStore((s) => s.active);
  const setManual = useOrderingStore((s) => s.setManual);
  const analysisRunning = useAnalysisStore((s) => s.running);

  // Freeze visible row positions while analysis is running so that
  // computed orders (bpm-asc, camelot, energy…) don't reshuffle rows on
  // every track update — that "dancing" makes the list feel unstable and
  // wastes WebView paint budget. Track data still updates in place; only
  // the position is held until the run finishes.
  const frozenIdsRef = useRef<string[] | null>(null);
  useEffect(() => {
    if (analysisRunning) {
      if (!frozenIdsRef.current) {
        frozenIdsRef.current = orderedLive.map((t) => t.id);
      }
    } else {
      frozenIdsRef.current = null;
    }
  }, [analysisRunning, orderedLive]);

  const ordered = useMemo<Track[]>(() => {
    const frozen = analysisRunning ? frozenIdsRef.current : null;
    if (!frozen) return orderedLive;
    const byId = new Map(orderedLive.map((t) => [t.id, t] as const));
    const out: Track[] = [];
    const seen = new Set<string>();
    for (const id of frozen) {
      const t = byId.get(id);
      if (t) {
        out.push(t);
        seen.add(id);
      }
    }
    for (const t of orderedLive) if (!seen.has(t.id)) out.push(t);
    return out;
  }, [analysisRunning, orderedLive]);

  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_FILTERS);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  // Android back-button integration:
  //  - a non-empty selection is cleared first (innermost handler, LIFO top),
  //  - then an active search query is cleared,
  //  - then Radix overlays / history / native Android leave take over (android-back.ts).
  useBackHandler(selectedIds.size > 0, () => {
    clear();
    return true;
  });
  useBackHandler(query.length > 0, () => {
    setQuery("");
    setSettledQuery("");
    return true;
  });

  // Android WebView can stall if a large library is filtered synchronously on
  // every key event. Keep the input instant and apply filtering after typing
  // settles for a short native-app-friendly delay.
  useEffect(() => {
    const handle = window.setTimeout(() => setSettledQuery(query), 140);
    return () => window.clearTimeout(handle);
  }, [query]);

  const { tracks: filtered, pending: filtering } = useChunkedTrackFilter(
    ordered,
    settledQuery,
    filters,
  );

  // When the user has selected a single track, compare every row to it.
  const compareTo = useMemo<Track | null>(() => {
    if (selectedIds.size !== 1) return null;
    const id = selectedIds.values().next().value as string | undefined;
    return id ? ordered.find((t) => t.id === id) ?? null : null;
  }, [selectedIds, ordered]);

  const activeCount = filtersActiveCount(filters);
  const orderedIndexById = useMemo(() => {
    const map = new Map<string, number>();
    ordered.forEach((track, index) => map.set(track.id, index));
    return map;
  }, [ordered]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: reorderMode ? 12 : 4,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 120, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const filteredIds = useMemo(() => filtered.map((t) => t.id), [filtered]);
  const activeDragTrack = useMemo(
    () => (activeDragId ? filtered.find((t) => t.id === activeDragId) ?? null : null),
    [activeDragId, filtered],
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveDragId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    // Reorder using the visible filtered list, then merge back into the full ordered list.
    const visibleIds = filtered.map((t) => t.id);
    const from = visibleIds.indexOf(String(active.id));
    const to = visibleIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const newVisible = arrayMove(visibleIds, from, to);
    // Rebuild full id list: replace visible positions in-order with newVisible.
    const fullIds = ordered.map((t) => t.id);
    const visibleSet = new Set(visibleIds);
    let vi = 0;
    const next = fullIds.map((id) => (visibleSet.has(id) ? newVisible[vi++] : id));
    setManual(next);
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Recherche : titre, 124, 120-125, 8A…"
            className="h-11 w-full rounded-xl border border-border bg-[var(--surface-elevated)] pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
        </div>
        <button
          aria-label={reorderMode ? "Quitter le mode manuel" : "Réorganiser"}
          onClick={() => setReorderMode((v) => !v)}
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border transition-colors ${
            reorderMode
              ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary-glow)]"
              : "border-border bg-[var(--surface-elevated)] text-muted-foreground hover:text-foreground"
          }`}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          aria-label="Filtres"
          onClick={() => setSheetOpen(true)}
          className="relative grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-border bg-[var(--surface-elevated)] text-muted-foreground hover:text-foreground"
        >
          <SlidersHorizontal className="h-4 w-4" />
          {activeCount > 0 && (
            <span className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--primary)] px-1 text-[10px] font-semibold text-[var(--primary-foreground)]">
              {activeCount}
            </span>
          )}
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 px-4 pb-1 text-xs text-muted-foreground tabular-nums">
        <span>
          {filtered.length.toLocaleString()} / {ordered.length.toLocaleString()} morceaux
          {filtering ? " · recherche…" : ""}
        </span>
        <span className="truncate text-[var(--primary-glow)]">
          Ordre actif : {active?.label ?? "Ordre d'import"}
        </span>
      </div>

      {selectedIds.size > 0 && (
        <div className="mx-4 mb-2 flex items-center justify-between rounded-lg bg-[var(--primary)]/15 px-3 py-2 text-xs">
          <span className="font-medium">{selectedIds.size} sélectionné{selectedIds.size > 1 ? "s" : ""}</span>
          <button onClick={clear} className="text-[var(--primary-glow)] font-medium">Annuler</button>
        </div>
      )}

      <div ref={parentRef} className="flex-1 overflow-y-auto px-4 pb-32">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDragId(null)}
          autoScroll={{ threshold: { x: 0, y: 0.2 }, acceleration: 25 }}
        >
        <SortableContext items={filteredIds} strategy={verticalListSortingStrategy}>
        {reorderMode ? (
          // In reorder mode, render in normal flow so sibling rows can shift
          // and open a gap for the dragged item (dnd-kit's transform-based
          // animations require non-absolutely-positioned siblings to look
          // correct). For libraries up to a few thousand tracks this remains
          // smooth on Android WebView.
          <div className="space-y-2">
            {filtered.map((track, i) => {
              const orderedIndex = orderedIndexById.get(track.id) ?? i;
              return (
                <SortableTrackRow
                  key={track.id}
                  track={track}
                  index={orderedIndex}
                  selected={selectedIds.has(track.id)}
                  onToggle={() => toggle(track.id)}
                  onOpenDetails={() => setDetailId(track.id)}
                  reorderMode={reorderMode}
                  compareTo={compareTo}
                />
              );
            })}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const track = filtered[vi.index];
              const orderedIndex = orderedIndexById.get(track.id) ?? vi.index;
              return (
                <div
                  key={track.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vi.start}px)`,
                    paddingBottom: 8,
                  }}
                >
                  <SortableTrackRow
                    track={track}
                    index={orderedIndex}
                    selected={selectedIds.has(track.id)}
                    onToggle={() => toggle(track.id)}
                    onOpenDetails={() => setDetailId(track.id)}
                    reorderMode={reorderMode}
                    compareTo={compareTo}
                  />
                </div>
              );
            })}
          </div>
        )}
        </SortableContext>
        <DragOverlay dropAnimation={{ duration: 180 }}>
          {activeDragTrack ? (
            <TrackRow
              track={activeDragTrack}
              index={orderedIndexById.get(activeDragTrack.id) ?? 0}
              selected={selectedIds.has(activeDragTrack.id)}
              onToggle={() => {}}
              onOpenDetails={() => {}}
              reorderMode={true}
              compareTo={compareTo}
              isDragging
            />
          ) : null}
        </DragOverlay>
        </DndContext>
        {filtered.length === 0 && (
          ordered.length === 0 ? (
            <EmptyState
              icon={Music2}
              title="Bibliothèque vide"
              description="Importez votre première bibliothèque musicale pour démarrer."
            />
          ) : (
            <EmptyState
              icon={SearchX}
              title="Aucun résultat"
              description="Aucun morceau ne correspond à votre recherche ou à vos filtres."
            />
          )
        )}
      </div>

      <FilterSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        filters={filters}
        onChange={setFilters}
      />
      <TrackDetailSheet trackId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
