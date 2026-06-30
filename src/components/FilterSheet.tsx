import { X, RotateCcw } from "lucide-react";
import {
  CAMELOT_CODES,
  type LibraryFilters,
  type DurationBucket,
  type AnalysisFilter,
  DEFAULT_FILTERS,
} from "@/lib/library-filters";
import {
  useOrderingStore,
  DEFAULT_ORDER_LABEL,
  type OrderSource,
} from "@/lib/ordering-store";
import { useBackHandler } from "@/hooks/useBackHandler";
import { closeAndroidSafe, releaseAndroidFocusMarker, stabilizeAndroidFocus } from "@/lib/android-ui";

interface Props {
  open: boolean;
  onClose: () => void;
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
}

const DURATIONS: { id: DurationBucket; label: string }[] = [
  { id: "short", label: "< 3 min" },
  { id: "medium", label: "3–5 min" },
  { id: "long", label: "> 5 min" },
];

const ANALYSIS: { id: AnalysisFilter; label: string }[] = [
  { id: "any", label: "Tous" },
  { id: "analyzed", label: "Analysés" },
  { id: "pending", label: "En attente" },
  { id: "error", label: "Erreurs" },
];

// Sort options that can be promoted to the global active order.
const SORTS: { id: OrderSource; label: string }[] = [
  { id: "import", label: DEFAULT_ORDER_LABEL.import },
  { id: "bpm-asc", label: "BPM ↑" },
  { id: "bpm-desc", label: "BPM ↓" },
  { id: "camelot", label: DEFAULT_ORDER_LABEL.camelot },
  { id: "duration", label: DEFAULT_ORDER_LABEL.duration },
  { id: "title", label: DEFAULT_ORDER_LABEL.title },
  { id: "energy", label: DEFAULT_ORDER_LABEL.energy },
];

export function FilterSheet({ open, onClose, filters, onChange }: Props) {
  const active = useOrderingStore((s) => s.active);
  const setOrder = useOrderingStore((s) => s.setOrder);
  const handleClose = () => closeAndroidSafe(onClose);

  useBackHandler(open, () => {
    handleClose();
    return true;
  });

  if (!open) return null;

  function toggleCamelot(code: string) {
    const next = new Set(filters.camelot);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange({ ...filters, camelot: next });
  }
  function toggleDuration(d: DurationBucket) {
    const next = new Set(filters.durations);
    if (next.has(d)) next.delete(d);
    else next.add(d);
    onChange({ ...filters, durations: next });
  }

  const activeSource = active?.source ?? "import";

  return (
    <div
      className="android-fixed-layer fixed inset-0 z-50 flex flex-col justify-end bg-background/75"
      data-tempokey-overlay="open"
    >
      <button aria-label="Fermer" onClick={handleClose} data-tempokey-close="true" className="flex-1" />
      <div role="dialog" data-state="open" aria-label="Filtres et tri" className="android-bottom-sheet rounded-t-2xl border-t border-border bg-[var(--surface)] max-h-[85dvh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-[var(--surface)] px-4 py-3">
          <h2 className="text-base font-semibold">Filtres & tri</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                onChange({ ...DEFAULT_FILTERS, camelot: new Set(), durations: new Set() });
                setOrder("import");
              }}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Réinitialiser
            </button>
            <button
              onClick={handleClose}
              aria-label="Fermer"
              data-tempokey-close="true"
              className="grid h-9 w-9 place-items-center rounded-lg hover:bg-accent"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-5 px-4 py-4">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              BPM
            </h3>
            <div className="flex items-center gap-2">
              <NumberInput
                value={filters.bpmMin}
                placeholder="Min"
                onChange={(v) => onChange({ ...filters, bpmMin: v })}
              />
              <span className="text-muted-foreground">—</span>
              <NumberInput
                value={filters.bpmMax}
                placeholder="Max"
                onChange={(v) => onChange({ ...filters, bpmMax: v })}
              />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Camelot
            </h3>
            <div className="grid grid-cols-6 gap-1.5">
              {CAMELOT_CODES.map((c) => {
                const a = filters.camelot.has(c);
                return (
                  <button
                    key={c}
                    onClick={() => toggleCamelot(c)}
                    className={`h-9 rounded-lg border text-xs font-semibold tabular-nums transition-colors ${
                      a
                        ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary-glow)]"
                        : "border-border bg-[var(--surface-elevated)] text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Durée
            </h3>
            <ChipRow
              items={DURATIONS}
              isActive={(d) => filters.durations.has(d.id)}
              onToggle={(d) => toggleDuration(d.id)}
            />
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Analyse
            </h3>
            <ChipRow
              items={ANALYSIS}
              isActive={(a) => filters.analysis === a.id}
              onToggle={(a) => onChange({ ...filters, analysis: a.id })}
            />
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Ordre actif de la bibliothèque
            </h3>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Appliqué à la Bibliothèque, l'Analyse et le Renommage.
            </p>
            <ChipRow
              items={SORTS}
              isActive={(s) => activeSource === s.id}
              onToggle={(s) => setOrder(s.id)}
            />
          </section>
        </div>

        <div className="sticky bottom-0 border-t border-border bg-[var(--surface)] px-4 py-3 safe-pb safe-px">
          <button
            onClick={handleClose}
            className="h-11 w-full rounded-xl text-sm font-semibold text-[var(--primary-foreground)]"
            style={{ background: "var(--gradient-primary)" }}
          >
            Appliquer
          </button>
        </div>
      </div>
    </div>
  );
}

function NumberInput({
  value,
  placeholder,
  onChange,
}: {
  value: number | null;
  placeholder: string;
  onChange: (v: number | null) => void;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? null : Math.max(0, +v));
      }}
      onFocus={(e) => stabilizeAndroidFocus(e.currentTarget)}
      onBlur={releaseAndroidFocusMarker}
      className="h-10 w-full rounded-lg border border-border bg-[var(--surface-elevated)] px-3 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
    />
  );
}

function ChipRow<T extends { id: string; label: string }>({
  items,
  isActive,
  onToggle,
}: {
  items: T[];
  isActive: (item: T) => boolean;
  onToggle: (item: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it) => {
        const a = isActive(it);
        return (
          <button
            key={it.id}
            onClick={() => onToggle(it)}
            className={`h-9 rounded-full border px-3 text-xs font-medium transition-colors ${
              a
                ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary-glow)]"
                : "border-border bg-[var(--surface-elevated)] text-muted-foreground hover:text-foreground"
            }`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
