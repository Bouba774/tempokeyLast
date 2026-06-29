import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Shield, FileText, BarChart3, Bug, ChevronRight } from "lucide-react";
import { usePrivacyStore } from "@/lib/analytics-store";
import {
  ArrowLeft,
  Sun,
  Moon,
  Monitor,
  Library as LibraryIcon,
  Database,
  Sparkles,
  Type,
  Music2,
  Gauge,
  Info,
  Mail,
  Trash2,
  RotateCw,
  RefreshCw,
  FolderOpen,
  Hammer,
  Check,
  Heart,
} from "lucide-react";
import { Copy, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import tempoKeyLogo from "@/assets/tempokey-logo.png";
import { useThemeStore } from "@/lib/theme-store";
import { useSettingsStore } from "@/lib/settings-store";
import { useLibraryStore } from "@/lib/library-store";
import { useAnalysisStore } from "@/lib/analysis-store";
import { usePlayerStore } from "@/lib/audio/player-store";
import {
  readCacheStats,
  clearAllCaches,
  pruneOrphanCache,
  formatBytes,
  formatRelativeDate,
  type CacheStats,
} from "@/lib/cache-admin";

const djLamboLogo = "/__l5e/assets-v1/07d653f9-85c0-4145-b82a-8a34b44e5771/dj-lambo-premier-square.png";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Paramètres — TempoKey" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate();
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

  const library = useLibraryStore((s) => s.library);
  const lastMeta = useLibraryStore((s) => s.lastLibraryMeta);
  const hydrateLibrary = useLibraryStore((s) => s.hydrate);

  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const rename = useSettingsStore((s) => s.rename);
  const player = useSettingsStore((s) => s.player);
  const setRename = useSettingsStore((s) => s.setRename);
  const setPlayer = useSettingsStore((s) => s.setPlayer);

  const analysisRunning = useAnalysisStore((s) => s.running);
  const reanalyzeAll = useAnalysisStore((s) => s.reanalyzeAll);

  const playerVolume = usePlayerStore((s) => s.volume);
  const setPlayerVolume = usePlayerStore((s) => s.setVolume);

  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);

  async function refreshStats() {
    setLoadingStats(true);
    try {
      const s = await readCacheStats();
      setCacheStats(s);
    } finally {
      setLoadingStats(false);
    }
  }

  useEffect(() => {
    hydrateSettings();
    hydrateLibrary();
    void refreshStats();
  }, [hydrateLibrary, hydrateSettings]);

  const lastAnalysis = useMemo(() => {
    if (!library) return null;
    let max: number | null = null;
    for (const t of library.tracks) {
      const at = t.detected?.detectedAt ?? null;
      if (at && (!max || at > max)) max = at;
    }
    return max;
  }, [library]);

  const waveformsGenerated = cacheStats?.waveformCount ?? 0;
  const indexedCount = library?.tracks.length ?? 0;
  const totalBytes = useMemo(() => {
    if (!library) return 0;
    return library.tracks.reduce((acc, t) => acc + (t.size ?? 0), 0);
  }, [library]);

  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-card/90 backdrop-blur-md px-2 py-2.5 safe-pt safe-px">
        <Link
          to="/workspace"
          aria-label="Retour"
          className="grid h-11 w-11 place-items-center rounded-full text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-[15px] font-semibold tracking-tight">Paramètres</h1>
          <p className="text-[11px] text-muted-foreground">Centre de contrôle TempoKey</p>
        </div>
      </header>

      <div className="px-4 py-5 pb-32 max-w-2xl mx-auto space-y-7 animate-fade-in">
        {/* APPARENCE */}
        <Section title="Apparence" icon={<Sparkles className="h-3.5 w-3.5" />}>
          <Card>
            <div className="px-4 pt-4 pb-2">
              <div className="text-sm font-medium">Thème de l'application</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Le mode système suit automatiquement les réglages de votre appareil.
              </p>
            </div>
            <div className="p-3 grid grid-cols-3 gap-2">
              <ThemeChoice
                label="Clair"
                icon={<Sun className="h-5 w-5" />}
                active={mode === "light"}
                onClick={() => setMode("light")}
              />
              <ThemeChoice
                label="Sombre"
                icon={<Moon className="h-5 w-5" />}
                active={mode === "dark"}
                onClick={() => setMode("dark")}
              />
              <ThemeChoice
                label="Système"
                icon={<Monitor className="h-5 w-5" />}
                active={mode === "system"}
                onClick={() => setMode("system")}
              />
            </div>
          </Card>
        </Section>

        {/* BIBLIOTHÈQUE */}
        <Section title="Bibliothèque" icon={<LibraryIcon className="h-3.5 w-3.5" />}>
          <Card>
            <InfoRow
              label="Bibliothèque active"
              value={library?.name ?? lastMeta?.name ?? "Aucune"}
            />
            <InfoRow
              label="Morceaux"
              value={indexedCount > 0 ? `${indexedCount.toLocaleString("fr-FR")} titres` : "—"}
            />
            <InfoRow
              label="Dernière analyse"
              value={formatRelativeDate(lastAnalysis)}
            />
          </Card>
          <ActionGroup>
            <ActionRow
              icon={<RotateCw className="h-4 w-4" />}
              label="Réanalyser la bibliothèque"
              hint="Relance l'analyse de tous les morceaux (verrous respectés)."
              disabled={!library || analysisRunning}
              onClick={async () => {
                if (!library) return;
                toast.message("Analyse lancée", { description: `${library.tracks.length} morceaux` });
                await reanalyzeAll();
                await refreshStats();
                toast.success("Analyse terminée");
              }}
            />
            <ActionRow
              icon={<RefreshCw className="h-4 w-4" />}
              label="Actualiser la bibliothèque"
              hint="Recharge la bibliothèque depuis le stockage local."
              onClick={async () => {
                await refreshStats();
                toast.success("Bibliothèque actualisée");
              }}
            />
            <ActionRow
              icon={<FolderOpen className="h-4 w-4" />}
              label="Changer de bibliothèque"
              hint="Importer un nouveau dossier audio."
              onClick={() => navigate({ to: "/" })}
            />
          </ActionGroup>
        </Section>

        {/* CACHE */}
        <Section title="Analyse et Cache" icon={<Database className="h-3.5 w-3.5" />}>
          <Card>
            <InfoRow
              label="Analyses en cache"
              value={loadingStats ? "…" : (cacheStats?.analysisCount ?? 0).toLocaleString("fr-FR")}
            />
            <InfoRow
              label="Waveforms en cache"
              value={loadingStats ? "…" : (cacheStats?.waveformCount ?? 0).toLocaleString("fr-FR")}
            />
            <InfoRow
              label="Taille totale (estimation)"
              value={loadingStats ? "…" : formatBytes(cacheStats?.estimatedBytes ?? null)}
            />
            <InfoRow
              label="Dernière mise à jour"
              value={formatRelativeDate(cacheStats?.lastUpdated ?? null)}
            />
          </Card>
          <ActionGroup>
            <ActionRow
              icon={<Hammer className="h-4 w-4" />}
              label="Reconstruire le cache"
              hint="Vide puis relance l'analyse complète."
              disabled={!library || analysisRunning}
              tone="primary"
              onClick={async () => {
                if (!library) return;
                await clearAllCaches();
                await refreshStats();
                toast.message("Cache reconstruit", { description: "Analyse en cours…" });
                await reanalyzeAll();
                await refreshStats();
                toast.success("Reconstruction terminée");
              }}
            />
            <ActionRow
              icon={<RefreshCw className="h-4 w-4" />}
              label="Nettoyer les données inutilisées"
              hint="Supprime les entrées qui ne correspondent à aucun morceau actif."
              onClick={async () => {
                const { removed } = await pruneOrphanCache();
                await refreshStats();
                toast.success(`${removed} entrée${removed > 1 ? "s" : ""} nettoyée${removed > 1 ? "s" : ""}`);
              }}
            />
            <ActionRow
              icon={<Trash2 className="h-4 w-4" />}
              label="Vider entièrement le cache"
              hint="Supprime toutes les analyses et waveforms en local."
              tone="danger"
              onClick={async () => {
                await clearAllCaches();
                await refreshStats();
                toast.success("Cache vidé");
              }}
            />
          </ActionGroup>
        </Section>

        {/* RENOMMAGE */}
        <Section title="Renommage" icon={<Type className="h-3.5 w-3.5" />}>
          <Card>
            <ToggleRow
              label="Nettoyer automatiquement les préfixes"
              hint="Supprime les anciens numéros, BPM ou Camelot avant renommage."
              checked={rename.cleanPrefixes}
              onChange={(v) => setRename({ cleanPrefixes: v })}
            />
            <ToggleRow
              label="Conserver une sauvegarde pour annulation"
              hint="Enregistre l'historique de renommage pour revenir en arrière."
              checked={rename.keepBackup}
              onChange={(v) => setRename({ keepBackup: v })}
            />
            <ToggleRow
              label="Détecter les conflits avant renommage"
              hint="Vérifie les doublons de noms et d'emplacements en amont."
              checked={rename.detectConflicts}
              onChange={(v) => setRename({ detectConflicts: v })}
            />
          </Card>
        </Section>

        {/* LECTEUR */}
        <Section title="Lecteur" icon={<Music2 className="h-3.5 w-3.5" />}>
          <Card>
            <div className="px-4 py-3.5 border-b border-border/60">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Volume par défaut</div>
                  <div className="text-xs text-muted-foreground">
                    Niveau appliqué à l'ouverture d'un morceau.
                  </div>
                </div>
                <div className="text-sm tabular-nums text-muted-foreground w-10 text-right">
                  {Math.round(player.defaultVolume * 100)}%
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(player.defaultVolume * 100)}
                onChange={(e) => {
                  const v = Number(e.target.value) / 100;
                  setPlayer({ defaultVolume: v });
                  // Apply immediately to current playback context.
                  setPlayerVolume(v);
                }}
                className="mt-3 w-full accent-[var(--primary)]"
                aria-label="Volume par défaut"
              />
              <div className="mt-1 text-[11px] text-muted-foreground">
                Volume actif&nbsp;: {Math.round(playerVolume * 100)}%
              </div>
            </div>
            <ToggleRow
              label="Préchargement des waveforms"
              hint="Génère les formes d'onde en arrière-plan pour une pré-écoute instantanée."
              checked={player.preloadWaveforms}
              onChange={(v) => setPlayer({ preloadWaveforms: v })}
            />
            <ToggleRow
              label="Lecture automatique"
              hint="Démarre la lecture dès qu'un morceau est sélectionné."
              checked={player.autoplay}
              onChange={(v) => setPlayer({ autoplay: v })}
            />
          </Card>
        </Section>

        {/* PERFORMANCE */}
        <Section title="Performance" icon={<Gauge className="h-3.5 w-3.5" />}>
          <Card>
            <InfoRow
              label="Morceaux indexés"
              value={indexedCount.toLocaleString("fr-FR")}
            />
            <InfoRow
              label="Taille de la bibliothèque"
              value={formatBytes(totalBytes || null)}
            />
            <InfoRow
              label="Waveforms générées"
              value={waveformsGenerated.toLocaleString("fr-FR")}
            />
          </Card>
          <p className="px-1 pt-2 text-[11px] text-muted-foreground">
            Informations en lecture seule.
          </p>
        </Section>

        {/* CONFIDENTIALITÉ */}
        <PrivacySection />

        {/* À PROPOS */}
        <Section title="À propos" icon={<Info className="h-3.5 w-3.5" />}>
          <Card>
            <div className="p-5 flex items-center gap-4">
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl bg-[var(--surface-elevated)]">
                <img
                  src={tempoKeyLogo}
                  alt="TempoKey"
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              </div>
              <div className="min-w-0">
                <div className="text-base font-semibold tracking-tight">TempoKey</div>
                <div className="text-xs text-muted-foreground leading-snug">
                  Outil d'analyse musicale et d'organisation DJ.
                </div>
              </div>
            </div>
            <div className="border-t border-border/60">
              <div className="flex items-center gap-4 px-5 py-3.5 border-b border-border/60">
                <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl bg-black">
                  <img
                    src={djLamboLogo}
                    alt="DJ LAMBO Premier"
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.1em] font-semibold text-muted-foreground">
                    Créé par
                  </div>
                  <div className="mt-0.5 text-sm font-medium text-foreground">
                    DJ LAMBO Premier
                  </div>
                </div>
              </div>
              <ContactRow email="djlambopremierofficiel@gmail.com" />
            </div>
          </Card>
          <Card>
            <details className="group">
              <summary className="list-none cursor-pointer flex items-center gap-3 px-4 py-3.5 hover:bg-accent/30 transition-colors">
                <Heart className="h-4 w-4 text-[var(--accent)]" />
                <span className="flex-1 text-sm font-medium">Remerciements</span>
                <span className="text-xs text-muted-foreground group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="px-4 pb-4 text-xs text-muted-foreground leading-relaxed border-t border-border/60 pt-3">
                Merci aux DJs et producteurs qui ont testé TempoKey et partagé leurs retours, ainsi qu'aux mainteneurs des bibliothèques open source qui rendent cet outil possible.
              </div>
            </details>
            <Link
              to="/licenses"
              className="flex items-center gap-3 border-t border-border/60 px-4 py-3.5 text-sm hover:bg-accent/30 transition-colors"
            >
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 font-medium">Licences open source</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
            <Link
              to="/privacy"
              className="flex items-center gap-3 border-t border-border/60 px-4 py-3.5 text-sm hover:bg-accent/30 transition-colors"
            >
              <Shield className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 font-medium">Politique de confidentialité</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          </Card>
        </Section>
      </div>
    </div>
  );
}

/* ---------------- UI primitives ---------------- */

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2 animate-fade-in">
      <h2 className="px-1 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
        {icon}
        {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-2xl border border-border bg-card"
      style={{ boxShadow: "var(--shadow-card)" }}
    >
      {children}
    </div>
  );
}

function ActionGroup({ children }: { children: React.ReactNode }) {
  return <Card>{children}</Card>;
}

function ThemeChoice({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`relative flex flex-col items-center justify-center gap-2 py-4 rounded-xl border transition-all press min-h-[88px] ${
        active
          ? "border-[var(--primary)] bg-[var(--primary)]/10 text-foreground"
          : "border-border bg-[var(--surface)]/40 hover:bg-accent/30 text-muted-foreground"
      }`}
    >
      <span className={active ? "text-[var(--primary-glow)]" : ""}>{icon}</span>
      <span className="text-xs font-medium">{label}</span>
      {active && (
        <span className="absolute top-1.5 right-1.5 grid h-4 w-4 place-items-center rounded-full bg-[var(--primary)] text-primary-foreground">
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-border/60 last:border-b-0">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-sm font-medium text-foreground text-right truncate tabular-nums">
        {value}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-right">{value}</span>
    </div>
  );
}

/**
 * Two-line meta row used in the "À propos" card.
 * Label sits tight above the value (no justify-between gap), so the value
 * stays visually anchored to its label — critical when the value is a long
 * email address that must remain fully visible on narrow phones.
 */
function MetaRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-3.5 border-b border-border/60 last:border-b-0">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--surface-elevated)] text-muted-foreground">
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] uppercase tracking-[0.1em] font-semibold text-muted-foreground">
          {label}
        </div>
        <div className="mt-0.5 text-sm font-medium text-foreground break-all">
          {value}
        </div>
      </div>
    </div>
  );
}

function ContactRow({ email }: { email: string }) {
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(email);
      } else {
        const ta = document.createElement("textarea");
        ta.value = email;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast.success("Adresse copiée", { description: email });
    } catch {
      toast.error("Impossible de copier l'adresse");
    }
  }

  return (
    <div className="flex items-start gap-3 px-5 py-3.5">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--surface-elevated)] text-muted-foreground">
        <Mail className="h-4 w-4" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] uppercase tracking-[0.1em] font-semibold text-muted-foreground">
          Contact
        </div>
        <a
          href={`mailto:${email}`}
          className="mt-0.5 block font-medium text-primary hover:underline whitespace-nowrap overflow-hidden text-ellipsis text-[clamp(10px,3.1vw,13px)]"
          title={email}
        >
          {email}
        </a>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label="Copier l'adresse e-mail"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors press"
      >
        <Copy className="h-4 w-4" />
      </button>
    </div>
  );
}

function ActionRow({
  icon,
  label,
  hint,
  onClick,
  disabled,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
}) {
  const toneClass =
    tone === "danger"
      ? "text-[var(--destructive)]"
      : tone === "primary"
        ? "text-[var(--primary-glow)]"
        : "text-foreground";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-start gap-3 px-4 py-3.5 text-left border-b border-border/60 last:border-b-0 hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors press"
    >
      <span
        className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--surface-elevated)] ${toneClass}`}
      >
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className={`block text-sm font-medium ${toneClass}`}>{label}</span>
        {hint && (
          <span className="block text-xs text-muted-foreground mt-0.5">{hint}</span>
        )}
      </span>
    </button>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="w-full flex items-center gap-3 px-4 py-3.5 text-left border-b border-border/60 last:border-b-0 hover:bg-accent/30 transition-colors"
    >
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint && (
          <span className="block text-xs text-muted-foreground mt-0.5">{hint}</span>
        )}
      </span>
      <span
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-[var(--primary)]" : "bg-[var(--surface-elevated)] border border-border"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-[22px]" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

/* ---------------- Privacy section (opt-in analytics / crash reports) ---------------- */

function PrivacySection() {
  const hydrate = usePrivacyStore((s) => s.hydrate);
  const analytics = usePrivacyStore((s) => s.analytics);
  const crashReports = usePrivacyStore((s) => s.crashReports);
  const setPriv = usePrivacyStore((s) => s.set);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return (
    <Section title="Confidentialité" icon={<Shield className="h-3.5 w-3.5" />}>
      <Card>
        <div className="px-4 pt-3.5 pb-2 text-xs text-muted-foreground">
          TempoKey fonctionne hors ligne. Ces options sont désactivées par défaut.
        </div>
        <ToggleRow
          label="Analytics anonymes"
          hint="Évènements agrégés, jamais de noms de fichiers."
          checked={analytics}
          onChange={(v) => setPriv({ analytics: v })}
        />
        <ToggleRow
          label="Rapports de crash"
          hint="Traces techniques uniquement, aucune donnée personnelle."
          checked={crashReports}
          onChange={(v) => setPriv({ crashReports: v })}
        />
        <Link
          to="/privacy"
          className="flex items-center gap-3 border-t border-border/60 px-4 py-3.5 text-sm hover:bg-accent/30 transition-colors"
        >
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1 font-medium">Lire la politique de confidentialité</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      </Card>
    </Section>
  );
}




