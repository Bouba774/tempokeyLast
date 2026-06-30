import { useCallback, useEffect, useMemo, useState } from "react";
import {
  X,
  Lock,
  Unlock,
  RotateCcw,
  RefreshCw,
  Check,
  ChevronDown,
  AlertTriangle,
} from "lucide-react";
import { useLibraryStore } from "@/lib/library-store";
import { useAnalysisStore } from "@/lib/analysis-store";
import { useBackHandler } from "@/hooks/useBackHandler";
import { closeAndroidSafe, stabilizeAndroidFocus } from "@/lib/android-ui";
import {
  ALL_CAMELOT,
  confidenceLabel,
  confidenceText,
  confidenceTone,
  lockBpm,
  lockKey,
  multiplyBpm,
  restoreDetectedBpm,
  restoreDetectedKey,
  setManualBpm,
  setManualCamelot,
} from "@/lib/corrections";

export function TrackDetailSheet({
  trackId,
  onClose,
}: {
  trackId: string | null;
  onClose: () => void;
}) {
  const track = useLibraryStore((s) =>
    trackId ? s.library?.tracks.find((t) => t.id === trackId) ?? null : null,
  );
  const reanalyze = useAnalysisStore((s) => s.reanalyzeIds);
  const running = useAnalysisStore((s) => s.running);

  const [bpmDraft, setBpmDraft] = useState<string>("");
  const [camelotOpen, setCamelotOpen] = useState(false);

  const handleClose = useCallback(() => {
    setCamelotOpen(false);
    closeAndroidSafe(onClose);
  }, [onClose]);

  useEffect(() => {
    setBpmDraft(track?.bpm != null ? String(track.bpm) : "");
    setCamelotOpen(false);
  }, [trackId, track?.bpm]);

  const open = !!trackId && !!track;
  const stats = useMemo(
    () =>
      track
        ? [
            { label: "Durée", value: track.duration ?? "—" },
            { label: "Format", value: track.extension?.toUpperCase() || "—" },
            {
              label: "Analysé",
              value: track.correctedAt ? "Corrigé" : track.analyzed ? "Oui" : "Non",
            },
          ]
        : [],
    [track],
  );

  // Safety net: if the parent ever leaves the sheet "open" with no matching
  // track (deleted/library reload), force a close so the user is never stuck.
  useEffect(() => {
    if (trackId && !track) handleClose();
  }, [trackId, track, handleClose]);

  // Android hardware back button closes the sheet first (LIFO, highest
  // priority while the sheet is open) before any other back behavior.
  useBackHandler(open, () => {
    handleClose();
    return true;
  });

  if (!open) return null;

  const bpmConf = confidenceLabel(track.bpmConfidence);
  const keyConf = confidenceLabel(track.keyConfidence);
  const bpmTone = confidenceTone(bpmConf);
  const keyTone = confidenceTone(keyConf);
  const detected = track.detected ?? null;
  const bpmChanged = detected && detected.bpm != null && track.bpm !== detected.bpm;
  const keyChanged = detected && detected.camelot && track.camelot !== detected.camelot;

  function commitBpm() {
    const n = parseFloat(bpmDraft.replace(",", "."));
    if (!isFinite(n) || n <= 0) return;
    setManualBpm(track!.id, n, true);
  }

  return (
    <div
      className="android-fixed-layer fixed inset-0 z-[60]"
      role="presentation"
      data-tempokey-overlay="open"
    >
      <button
        type="button"
        aria-label="Fermer les détails"
        onClick={handleClose}
        data-tempokey-close="true"
        className="absolute inset-0 bg-background/75"
      />
      <section
        role="dialog"
        data-state="open"
        aria-label="Détails du morceau"
        className="android-bottom-sheet absolute inset-x-0 bottom-0 z-[61] mx-auto max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-border bg-[var(--surface-elevated)] p-4 pb-[max(env(safe-area-inset-bottom,0px),16px)] shadow-2xl outline-none"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold text-foreground">
              {track.title}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {track.fileName}
            </div>
          </div>
          <button
            type="button"
            aria-label="Fermer"
            onClick={handleClose}
            data-tempokey-close="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {track.suspect && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" />
            Analyse à vérifier — résultat possiblement ambigu.
          </div>
        )}

        {/* BPM */}
        <section className="rounded-xl border border-border bg-card p-3">
          <header className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                BPM
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${bpmTone.text} ${bpmTone.bg} ${bpmTone.ring}`}
              >
                {confidenceText(bpmConf)}
                {track.bpmConfidence != null && (
                  <span className="tabular-nums opacity-80">
                    · {Math.round(track.bpmConfidence * 100)}%
                  </span>
                )}
              </span>
            </div>
            <button
              onClick={() => lockBpm(track.id, !track.bpmLocked)}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ${
                track.bpmLocked
                  ? "bg-[var(--primary)]/15 text-[var(--primary-glow)]"
                  : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {track.bpmLocked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
              {track.bpmLocked ? "Verrouillé" : "Verrouiller"}
            </button>
          </header>
          <div className="flex flex-wrap items-center gap-2">
            <input
              inputMode="decimal"
              value={bpmDraft}
              onChange={(e) => setBpmDraft(e.target.value)}
              onFocus={(e) => stabilizeAndroidFocus(e.currentTarget)}
              onBlur={commitBpm}
              className="h-10 w-28 rounded-lg border border-border bg-[var(--surface-elevated)] px-3 text-sm font-semibold tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
            <span className="text-xs text-muted-foreground">BPM</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => multiplyBpm(track.id, 0.5)}
                disabled={track.bpm == null}
                className="rounded-md border border-border bg-[var(--surface-elevated)] px-2 py-1 text-[11px] font-semibold text-foreground hover:bg-accent disabled:opacity-40"
              >
                ÷2
              </button>
              <button
                onClick={() => multiplyBpm(track.id, 2)}
                disabled={track.bpm == null}
                className="rounded-md border border-border bg-[var(--surface-elevated)] px-2 py-1 text-[11px] font-semibold text-foreground hover:bg-accent disabled:opacity-40"
              >
                ×2
              </button>
              <button
                onClick={commitBpm}
                className="rounded-md bg-[var(--primary)]/20 px-2 py-1 text-[11px] font-semibold text-[var(--primary-glow)] hover:bg-[var(--primary)]/30"
              >
                <Check className="inline h-3 w-3" /> OK
              </button>
            </div>
          </div>
          {detected && detected.bpm != null && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                Détecté : <span className="text-foreground tabular-nums">{detected.bpm}</span>
              </span>
              {bpmChanged && (
                <button
                  onClick={() => restoreDetectedBpm(track.id)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[var(--primary-glow)] hover:bg-accent"
                >
                  <RotateCcw className="h-3 w-3" /> Restaurer
                </button>
              )}
            </div>
          )}
        </section>

        {/* Tonalité */}
        <section className="mt-3 rounded-xl border border-border bg-card p-3">
          <header className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Tonalité
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${keyTone.text} ${keyTone.bg} ${keyTone.ring}`}
              >
                {confidenceText(keyConf)}
                {track.keyConfidence != null && (
                  <span className="tabular-nums opacity-80">
                    · {Math.round(track.keyConfidence * 100)}%
                  </span>
                )}
              </span>
            </div>
            <button
              onClick={() => lockKey(track.id, !track.keyLocked)}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ${
                track.keyLocked
                  ? "bg-[var(--primary)]/15 text-[var(--primary-glow)]"
                  : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {track.keyLocked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
              {track.keyLocked ? "Verrouillé" : "Verrouiller"}
            </button>
          </header>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-lg border border-border bg-[var(--surface-elevated)] px-3 py-2 text-sm font-semibold tabular-nums">
              {track.camelot ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground">{track.key ?? "—"}</div>
            <button
              onClick={() => setCamelotOpen((v) => !v)}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-[var(--surface-elevated)] px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent"
            >
              Modifier <ChevronDown className={`h-3 w-3 transition ${camelotOpen ? "rotate-180" : ""}`} />
            </button>
          </div>
          {camelotOpen && (
            <div className="mt-2 grid grid-cols-6 gap-1.5">
              {ALL_CAMELOT.map((code) => (
                <button
                  key={code}
                  onClick={() => {
                    setManualCamelot(track.id, code, true);
                    setCamelotOpen(false);
                  }}
                  className={`rounded-md px-1 py-1.5 text-[11px] font-semibold tabular-nums transition ${
                    track.camelot?.toUpperCase() === code
                      ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                      : "bg-[var(--surface-elevated)] text-foreground hover:bg-accent"
                  }`}
                >
                  {code}
                </button>
              ))}
            </div>
          )}
          {detected && detected.camelot && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                Détecté :{" "}
                <span className="text-foreground tabular-nums">{detected.camelot}</span>
                {detected.key && <span className="ml-1">({detected.key})</span>}
              </span>
              {keyChanged && (
                <button
                  onClick={() => restoreDetectedKey(track.id)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[var(--primary-glow)] hover:bg-accent"
                >
                  <RotateCcw className="h-3 w-3" /> Restaurer
                </button>
              )}
            </div>
          )}
        </section>

        {/* Détails */}
        <section className="mt-3 grid grid-cols-3 gap-2 text-center">
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg border border-border bg-card p-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {s.label}
              </div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{s.value}</div>
            </div>
          ))}
        </section>

        <button
          onClick={() => void reanalyze([track.id])}
          disabled={running}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-[var(--surface-elevated)] px-3 py-2.5 text-sm font-semibold text-foreground hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />
          Réanalyser ce morceau
        </button>
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          Les valeurs verrouillées ne sont jamais remplacées par une nouvelle analyse.
        </p>
      </section>
    </div>
  );
}
