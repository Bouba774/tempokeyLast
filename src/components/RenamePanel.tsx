import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CheckCheck,
  ChevronRight,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useLibraryStore } from "@/lib/library-store";
import { useOrderedTracks, useOrderingStore } from "@/lib/ordering-store";
import { buildPreview, TEMPLATES, TEMPLATE_VARIABLES, type TemplateId, type RenamePreviewItem } from "@/lib/rename/templates";
import { isFsAccessSupported } from "@/lib/rename/dir-handle";
import { applyRename, undoOperation, type ApplyProgress } from "@/lib/rename/engine";
import { loadHistory, type RenameOperation } from "@/lib/rename/history";
import { useBackHandler } from "@/hooks/useBackHandler";

type Step = "select" | "template" | "preview" | "applying" | "done";

const PREVIEW_LIMIT = 200;

function useSettledValue<T>(value: T, delay = 140): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const handle = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(handle);
  }, [value, delay]);

  return settled;
}

export function RenamePanel() {
  const library = useLibraryStore((s) => s.library);
  const selectedIds = useLibraryStore((s) => s.selectedIds);
  const tracks = useOrderedTracks();
  const activeOrder = useOrderingStore((s) => s.active);

  const [step, setStep] = useState<Step>("select");
  const [template, setTemplate] = useState<TemplateId>("dj-order");
  const [customFormat, setCustomFormat] = useState("{ORDER} - {BPM} - {KEY} - {TITLE}");
  const [cleanPrefixes, setCleanPrefixes] = useState(true);
  const [scope, setScope] = useState<"all" | "selection">(selectedIds.size > 0 ? "selection" : "all");
  const [progress, setProgress] = useState<ApplyProgress | null>(null);
  const [result, setResult] = useState<{ applied: number; failed: number; operationId: string | null } | null>(null);
  const [history, setHistory] = useState<RenameOperation[]>([]);
  const [undoBusy, setUndoBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settledCustomFormat = useSettledValue(customFormat);

  const fsSupported = isFsAccessSupported();

  // Android back-button: step back through the wizard so the hardware back
  // button never falls through to history.back() (which can crash the
  // WebView when popping a stale single-page history entry).
  useBackHandler(step !== "select" && step !== "applying", () => {
    if (step === "done") {
      resetWizard();
      return true;
    }
    if (step === "preview") {
      setStep("template");
      return true;
    }
    if (step === "template") {
      setStep("select");
      return true;
    }
    return false;
  });

  // Load history scoped to current library
  useEffect(() => {
    void loadHistory().then((list) => setHistory(list.filter((o) => o.libraryId === library?.id)));
  }, [library, result]);

  const scopedTracks = useMemo(() => {
    if (scope === "selection" && selectedIds.size > 0) {
      return tracks.filter((t) => selectedIds.has(t.id));
    }
    return tracks;
  }, [tracks, selectedIds, scope]);

  const preview = useMemo(
    () => (step === "preview" ? buildPreview(template, settledCustomFormat, scopedTracks, { cleanPrefixes }) : null),
    [step, template, settledCustomFormat, scopedTracks, cleanPrefixes],
  );

  async function runApply() {
    if (!preview) return;
    setStep("applying");
    setProgress({ done: 0, total: preview.changeCount });
    setError(null);
    try {
      const res = await applyRename(template, preview.items, (p) => setProgress(p));
      setResult({ applied: res.applied.length, failed: res.failed.length, operationId: res.operationId });
      setStep("done");
      if (res.failed.length === 0) {
        toast.success(`${res.applied.length} fichier${res.applied.length > 1 ? "s" : ""} renommé${res.applied.length > 1 ? "s" : ""}`);
      } else {
        toast.warning(`${res.applied.length} renommés · ${res.failed.length} échecs`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erreur inconnue";
      setError(msg);
      toast.error("Renommage interrompu", { description: msg });
      setStep("preview");
    } finally {
      setProgress(null);
    }
  }

  async function runUndo(opId: string) {
    setUndoBusy(opId);
    setError(null);
    try {
      await undoOperation(opId);
      const list = await loadHistory();
      setHistory(list.filter((o) => o.libraryId === library?.id));
      toast.success("Renommage annulé");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erreur d'annulation";
      setError(msg);
      toast.error("Annulation impossible", { description: msg });
    } finally {
      setUndoBusy(null);
    }
  }

  function resetWizard() {
    setStep("select");
    setResult(null);
    setProgress(null);
    setError(null);
  }

  if (!library) return null;

  if (!fsSupported) {
    return (
      <div className="px-4 py-8">
        <div className="rounded-xl border border-[var(--destructive,#ef4444)]/30 bg-[var(--destructive,#ef4444)]/10 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <ShieldAlert className="h-4 w-4 text-[var(--destructive,#ef4444)]" />
            Renommage non supporté par ce navigateur
          </div>
          <p className="mt-2 text-muted-foreground">
            Le renommage local nécessite l'API File System Access (Chrome, Edge, ou Android via APK).
            Sur d'autres navigateurs, cette fonctionnalité sera disponible une fois l'application empaquetée.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
      <Stepper step={step} />
      <div className="flex items-center gap-2 rounded-lg border border-border bg-[var(--surface-elevated)] px-3 py-2 text-xs">
        <span className="text-muted-foreground">Ordre actif</span>
        <span className="font-semibold text-[var(--primary-glow)]">
          {activeOrder?.label ?? "Ordre d'import"}
        </span>
        <span className="ml-auto text-muted-foreground tabular-nums">
          {scope === "selection" ? selectedIds.size : tracks.length} morceau
          {(scope === "selection" ? selectedIds.size : tracks.length) > 1 ? "x" : ""}
        </span>
      </div>
      {error && (
        <div className="rounded-lg border border-[var(--destructive,#ef4444)]/40 bg-[var(--destructive,#ef4444)]/10 px-3 py-2 text-sm text-foreground">
          {error}
        </div>
      )}

      {step === "select" && (
        <div className="space-y-3">
          <Section title="Portée">
            <div className="grid grid-cols-2 gap-2">
              <ScopeOption
                active={scope === "all"}
                onClick={() => setScope("all")}
                label="Toute la bibliothèque"
                sub={`${tracks.length.toLocaleString()} morceaux`}
              />
              <ScopeOption
                active={scope === "selection"}
                onClick={() => setScope("selection")}
                disabled={selectedIds.size === 0}
                label="Sélection"
                sub={selectedIds.size > 0 ? `${selectedIds.size} morceau${selectedIds.size > 1 ? "x" : ""}` : "aucune"}
              />
            </div>
          </Section>

          <button
            onClick={() => setStep("template")}
            disabled={scopedTracks.length === 0}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-[var(--primary-foreground)] disabled:opacity-40"
            style={{ background: "var(--gradient-primary)" }}
          >
            Choisir un template <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {step === "template" && (
        <div className="space-y-3">
          <Section title="Template">
            <ul className="space-y-2">
              {TEMPLATES.map((t) => {
                const active = template === t.id;
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => setTemplate(t.id)}
                      className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left ${
                        active ? "border-[var(--primary)] bg-[var(--primary)]/10" : "border-border bg-card"
                      }`}
                    >
                      <Sparkles className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "text-[var(--primary-glow)]" : "text-muted-foreground"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground">{t.label}</div>
                        <div className="text-xs text-muted-foreground">{t.description}</div>
                        <div className="mt-1 truncate text-xs tabular-nums text-[var(--primary-glow)]">{t.example}</div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>

          {template === "custom" && (
            <Section title="Format personnalisé">
              <input
                value={customFormat}
                onChange={(e) => setCustomFormat(e.target.value)}
                onFocus={(e) => window.setTimeout(() => e.currentTarget.scrollIntoView({ block: "center" }), 120)}
                className="h-11 w-full rounded-lg border border-border bg-[var(--surface-elevated)] px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                placeholder="{ORDER} - {BPM} - {KEY} - {TITLE}"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Variables : {TEMPLATE_VARIABLES.join(", ")}
              </p>
            </Section>
          )}

          <Section title="Options">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={cleanPrefixes}
                onChange={(e) => setCleanPrefixes(e.target.checked)}
                className="mt-1 h-4 w-4 accent-[var(--primary)]"
              />
              <span className="text-sm">
                <span className="font-medium text-foreground">Nettoyer les préfixes existants</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Retire automatiquement numéros, BPM, Camelot et séparateurs avant le titre.
                </span>
              </span>
            </label>
          </Section>


          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setStep("select")}
              className="h-12 rounded-xl border border-border bg-[var(--surface-elevated)] text-sm font-medium"
            >
              Retour
            </button>
            <button
              onClick={() => setStep("preview")}
              className="h-12 rounded-xl text-sm font-semibold text-[var(--primary-foreground)]"
              style={{ background: "var(--gradient-primary)" }}
            >
              Prévisualiser
            </button>
          </div>
        </div>
      )}

      {step === "preview" && preview && (
        <div className="space-y-3">
          <Section title={`Aperçu (${preview.changeCount.toLocaleString()} modifications${preview.duplicateCount > 0 ? ` · ${preview.duplicateCount} conflit${preview.duplicateCount > 1 ? "s" : ""} auto-résolu${preview.duplicateCount > 1 ? "s" : ""}` : ""})`}>
            {preview.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun morceau à renommer.</p>
            ) : (
              <>
                <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                  {preview.items.slice(0, PREVIEW_LIMIT).map((it, i) => (
                    <PreviewRow key={it.trackId} item={it} position={i + 1} showCleaned={cleanPrefixes} />
                  ))}
                </ul>
                {preview.items.length > PREVIEW_LIMIT && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Affichage des {PREVIEW_LIMIT} premiers · {preview.items.length - PREVIEW_LIMIT} autres seront traités.
                  </p>
                )}
              </>
            )}
          </Section>


          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setStep("template")}
              className="h-12 rounded-xl border border-border bg-[var(--surface-elevated)] text-sm font-medium"
            >
              Modifier
            </button>
            <button
              onClick={runApply}
              disabled={preview.changeCount === 0}
              className="h-12 rounded-xl text-sm font-semibold text-[var(--primary-foreground)] disabled:opacity-40"
              style={{ background: "var(--gradient-primary)" }}
            >
              Appliquer ({preview.changeCount})
            </button>
          </div>
        </div>
      )}

      {step === "applying" && progress && (
        <Section title="Renommage en cours">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--primary-glow)]" />
            <div className="flex-1">
              <div className="text-sm tabular-nums">
                {progress.done} / {progress.total}
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-elevated)]">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${progress.total === 0 ? 0 : (progress.done / progress.total) * 100}%`,
                    background: "var(--gradient-primary)",
                  }}
                />
              </div>
              {progress.current && (
                <div className="mt-1 truncate text-xs text-muted-foreground">{progress.current}</div>
              )}
            </div>
          </div>
        </Section>
      )}

      {step === "done" && result && (
        <div className="space-y-3">
          <Section title="Renommage terminé">
            <div className="flex items-center gap-2 text-sm">
              <CheckCheck className="h-5 w-5 text-[var(--primary-glow)]" />
              <span>
                {result.applied.toLocaleString()} fichier{result.applied > 1 ? "s" : ""} renommé{result.applied > 1 ? "s" : ""}
                {result.failed > 0 && (
                  <span className="ml-1 text-[var(--destructive,#ef4444)]">· {result.failed} échec{result.failed > 1 ? "s" : ""}</span>
                )}
              </span>
            </div>
          </Section>
          <button
            onClick={resetWizard}
            className="h-12 w-full rounded-xl border border-border bg-[var(--surface-elevated)] text-sm font-medium"
          >
            Nouveau renommage
          </button>
        </div>
      )}

      <Section title="Historique">
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune opération pour cette bibliothèque.</p>
        ) : (
          <ul className="space-y-2">
            {history.slice(0, 10).map((op) => (
              <li
                key={op.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-foreground">
                    {op.template} · {op.changes.length} fichier{op.changes.length > 1 ? "s" : ""}
                    {op.undone && <span className="ml-2 text-xs text-muted-foreground">(annulé)</span>}
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {new Date(op.at).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={() => runUndo(op.id)}
                  disabled={!!op.undone || undoBusy === op.id}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground disabled:opacity-40"
                >
                  {undoBusy === op.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  Annuler
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "select", label: "Sélection" },
    { id: "template", label: "Template" },
    { id: "preview", label: "Aperçu" },
    { id: "done", label: "Confirmé" },
  ];
  const activeIdx = steps.findIndex((s) => s.id === step);
  return (
    <ol className="flex items-center gap-1 text-xs">
      {steps.map((s, i) => {
        const active = i === activeIdx;
        const done = i < activeIdx;
        return (
          <li key={s.id} className="flex flex-1 items-center gap-1">
            <span
              className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold ${
                active
                  ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                  : done
                    ? "bg-[var(--primary)]/40 text-foreground"
                    : "bg-[var(--surface-elevated)] text-muted-foreground"
              }`}
            >
              {i + 1}
            </span>
            <span className={`truncate ${active ? "text-foreground font-medium" : "text-muted-foreground"}`}>
              {s.label}
            </span>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function ScopeOption({
  active,
  onClick,
  label,
  sub,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border p-3 text-left transition-colors disabled:opacity-40 ${
        active ? "border-[var(--primary)] bg-[var(--primary)]/10" : "border-border bg-card"
      }`}
    >
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </button>
  );
}

function PreviewRow({
  item,
  position,
  showCleaned,
}: {
  item: RenamePreviewItem;
  position: number;
  showCleaned: boolean;
}) {
  const cleanedDiffers = showCleaned && item.cleanedName !== item.oldName;
  return (
    <li className="flex gap-3 px-3 py-2 text-xs">
      <span className="w-10 shrink-0 text-right font-semibold tabular-nums text-[var(--primary-glow)]">
        {String(position).padStart(3, "0")}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="truncate text-muted-foreground" title={item.oldName}>
          {item.oldName}
        </div>
        {cleanedDiffers && (
          <div className="truncate text-[var(--primary-glow)]/80" title={item.cleanedName}>
            ↳ {item.cleanedName}
          </div>
        )}
        <div
          className={`truncate tabular-nums ${item.unchanged ? "text-muted-foreground" : "text-foreground font-medium"}`}
          title={item.newName}
        >
          → {item.newName}
          {item.unchanged && <span className="ml-2 text-[10px] uppercase text-muted-foreground">inchangé</span>}
          {item.duplicate && <span className="ml-2 text-[10px] uppercase text-[var(--primary-glow)]">auto-suffixe</span>}
        </div>
      </div>
    </li>
  );
}