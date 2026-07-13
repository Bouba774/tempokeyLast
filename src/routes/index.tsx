import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useLibraryStore,
  buildLibraryFromFiles,
  type ImportProgress,
} from "@/lib/library-store";
import { useAnalysisStore } from "@/lib/analysis-store";
import { ImportProgressModal } from "@/components/ImportProgressModal";
import {
  AudioWaveform,
  KeyRound,
  Disc3,
  Waves,
  ArrowDownUp,
  Blocks,
  Wand2,
  ScanSearch,
  Telescope,
  LockKeyhole,
  PlugZap,
  CloudOff,
  HardDrive,
  Headphones,
  ArrowUpRight,
} from "lucide-react";
import {
  FolderSearch,
  Sparkles,
  ListMusic,
  Gauge,
  Music2,
  Library,
  Filter,
  Layers,
  Copy,
  FileSignature,
  FolderTree,
  Hash,
  Activity,
  Radar,
} from "lucide-react";
import logoUrl from "@/assets/tempokey-logo.png";
import {
  filesFromDirectoryHandle,
  isFsAccessSupported,
  pickDirectoryHandle,
  saveDirectoryHandle,
} from "@/lib/rename/dir-handle";
import {
  isCapacitorAndroid,
  pickAndroidFolder,
  persistAndroidImportedFiles,
  persistAndroidLibrary,
  restoreFilesForLibrary,
} from "@/lib/native/folder-picker";
import {
  AudioPermissionDialog,
  type AudioPermissionDialogVariant,
} from "@/components/AudioPermissionDialog";
import {
  openAndroidAppSettings,
  requestAudioPermission,
} from "@/lib/android-permissions";
import { Switch } from "@/components/ui/switch";
import { useMixOrderModeStore } from "@/lib/mixorder-mode-store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "TempoKey — Analysez et organisez vos bibliothèques DJ" },
      {
        name: "description",
        content:
          "Outil DJ professionnel : analyse BPM, tonalité, Camelot, harmonic mixing et organisation intelligente — 100% local, sans cloud.",
      },
    ],
  }),
  component: Home,
});

const CATEGORIES = [
  {
    label: "Analyses musicales",
    icon: Activity,
    items: [
      { icon: AudioWaveform, title: "BPM haute précision", desc: "Tempo décimal fiable." },
      { icon: KeyRound, title: "Tonalité", desc: "Détection majeur / mineur." },
      { icon: Disc3, title: "Notation Camelot", desc: "Roue harmonique standard." },
      { icon: Waves, title: "Harmonic Mixing", desc: "Compatibilités instantanées." },
      { icon: Radar, title: "Analyses avancées", desc: "Énergie, structure, qualité." },
    ],
  },
  {
    label: "Organisation",
    icon: Layers,
    items: [
      { icon: ArrowDownUp, title: "Auto Mix Order", desc: "Enchaînements optimisés." },
      { icon: Blocks, title: "Set Builder", desc: "Warm-up · Peak · Closing." },
      { icon: Telescope, title: "Recherche avancée", desc: "BPM, clé, durée, mots." },
      { icon: Filter, title: "Filtres puissants", desc: "Croisez tous les critères." },
      { icon: ListMusic, title: "Préparation de sets", desc: "Playlists prêtes à jouer." },
    ],
  },
  {
    label: "Bibliothèque",
    icon: Library,
    items: [
      { icon: ScanSearch, title: "Doublons", desc: "Exacts et approximatifs." },
      { icon: Wand2, title: "Renommage intelligent", desc: "Templates DJ + undo." },
      { icon: FolderTree, title: "Réorganisation locale", desc: "Sur vos vrais fichiers." },
      { icon: Hash, title: "Préfixes d'ordre", desc: "Conservez l'ordre du mix." },
      { icon: HardDrive, title: "Grandes bibliothèques", desc: "Pensé pour le volume." },
    ],
  },
];

const BENEFITS = [
  { icon: Gauge, label: "Analyse BPM & tonalités" },
  { icon: ArrowDownUp, label: "Classement intelligent" },
  { icon: Waves, label: "Harmonic Mixing" },
  { icon: Blocks, label: "Set Builder" },
  { icon: ScanSearch, label: "Détection doublons" },
  { icon: FolderTree, label: "Réorganisation locale" },
  { icon: LockKeyhole, label: "100% local" },
  { icon: PlugZap, label: "Hors connexion" },
  { icon: CloudOff, label: "Zéro cloud" },
  { icon: HardDrive, label: "Bibliothèques massives" },
  { icon: Headphones, label: "Pensé pour DJs" },
];

const STEPS = [
  {
    n: 1,
    icon: FolderSearch,
    title: "Sélectionnez un dossier",
    desc: "Choisissez le dossier contenant vos fichiers audio.",
  },
  {
    n: 2,
    icon: Sparkles,
    title: "Analyse automatique",
    desc: "BPM, tonalités, Camelot et infos musicales en arrière-plan.",
  },
  {
    n: 3,
    icon: ListMusic,
    title: "Organisez et mixez",
    desc: "Classement intelligent, Set Builder, Harmonic Mixing, recherche et renommage.",
  },
];

const ADVANCED = [
  { icon: AudioWaveform, label: "Détection BPM avancée" },
  { icon: KeyRound, label: "Détection de tonalité" },
  { icon: Disc3, label: "Camelot" },
  { icon: Waves, label: "Harmonic Mixing" },
  { icon: Telescope, label: "Recherche multicritère" },
  { icon: ArrowDownUp, label: "Classement intelligent" },
  { icon: Wand2, label: "Renommage DJ" },
  { icon: ScanSearch, label: "Suppression doublons" },
  { icon: Music2, label: "Optimisation bibliothèque" },
];

function Home() {
  const navigate = useNavigate();
  const setLibrary = useLibraryStore((s) => s.setLibrary);
  const setFiles = useLibraryStore((s) => s.setFiles);
  const lastMeta = useLibraryStore((s) => s.lastLibraryMeta);
  const hydrated = useLibraryStore((s) => s.hydrated);
  const hydrate = useLibraryStore((s) => s.hydrate);
  const restoreLast = useLibraryStore((s) => s.restoreLast);
  const resetAnalysis = useAnalysisStore((s) => s.reset);
  const startAnalysis = useAnalysisStore((s) => s.start);
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [permissionDialog, setPermissionDialog] =
    useState<AudioPermissionDialogVariant | null>(null);
  const mixOrderEnabled = useMixOrderModeStore((s) => s.enabled);
  const setMixOrderEnabled = useMixOrderModeStore((s) => s.setEnabled);

  function destinationAfterImport(): "/mixorder" | "/workspace" {
    return useMixOrderModeStore.getState().enabled ? "/mixorder" : "/workspace";
  }

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  function pickFolder() {
    void openFolderPicker();
  }

  // Platform-routed folder picker:
  //  - Native Android (Capacitor)  → ACTION_OPEN_DOCUMENT_TREE via custom plugin
  //  - Desktop / mobile web        → File System Access API
  //  - Older browsers              → legacy <input webkitdirectory> fallback
  async function openFolderPicker() {
    if (isCapacitorAndroid()) {
      const state = await requestAudioPermission();
      if (state !== "granted") {
        setPermissionDialog(state === "blocked" ? "blocked" : "denied");
        return;
      }
      await openAndroidFolderAfterPermission();
      return;
    }
    if (isFsAccessSupported()) {
      const handle = await pickDirectoryHandle();
      if (!handle) return;
      setProgress({ phase: "scan", scanned: 0, total: 0 });
      try {
        const files = await filesFromDirectoryHandle(handle, (n) =>
          setProgress({ phase: "scan", scanned: n, total: n }),
        );
        const { library: lib, files: fileEntries } = await buildLibraryFromFiles(
          files,
          (p) => setProgress(p),
        );
        if (lib.tracks.length === 0) {
          setProgress(null);
          toast.error("Aucun fichier audio compatible", {
            description: "Formats acceptés : mp3, wav, flac, aac.",
          });
          return;
        }
        resetAnalysis();
        await setLibrary(lib);
        await saveDirectoryHandle(lib.id, handle);
        setFiles(fileEntries);
        setProgress({ phase: "done", scanned: lib.tracks.length, total: lib.tracks.length });
        toast.success(`${lib.tracks.length.toLocaleString()} morceaux importés`, {
          description: lib.name,
        });
        setTimeout(() => {
          setProgress(null);
          navigate({ to: destinationAfterImport() });
          void startAnalysis();
        }, 400);
      } catch (err) {
        console.error(err);
        setProgress(null);
        toast.error("Import impossible", {
          description: "Vérifie que le dossier est accessible et réessaie.",
        });
      }
      return;
    }
    inputRef.current?.click();
  }

  async function openAndroidFolderAfterPermission() {
    setProgress({ phase: "scan", scanned: 0, total: 0 });
    const result = await pickAndroidFolder();
    if (!result) {
      setProgress(null);
      return;
    }
    await importFiles(result.files, result.treeUri);
  }

  async function confirmAndroidPermission() {
    const state = await requestAudioPermission();
    if (state === "granted") {
      setPermissionDialog(null);
      await openAndroidFolderAfterPermission();
      return;
    }
    setPermissionDialog(state === "blocked" ? "blocked" : "denied");
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    if (files.length === 0) return;
    await importFiles(files);
  }

  async function importFiles(files: File[], androidTreeUri?: string) {
    setProgress({ phase: "scan", scanned: 0, total: files.length });
    try {
      const { library: lib, files: fileEntries } = await buildLibraryFromFiles(
        files,
        (p) => setProgress(p),
      );
      if (lib.tracks.length === 0) {
        setProgress(null);
        toast.error("Aucun fichier audio compatible", {
          description: "Formats acceptés : mp3, wav, flac, aac.",
        });
        return;
      }
      let durableEntries = fileEntries;
      if (androidTreeUri) {
        setProgress({ phase: "store", scanned: 0, total: lib.tracks.length });
        durableEntries = await persistAndroidImportedFiles(lib.id, fileEntries);
      }
      resetAnalysis();
      await setLibrary(lib);
      if (androidTreeUri) {
        await persistAndroidLibrary(lib.id, androidTreeUri, lib.name, durableEntries);
      }
      setFiles(durableEntries);
      setProgress({ phase: "done", scanned: lib.tracks.length, total: lib.tracks.length });
      toast.success(`${lib.tracks.length.toLocaleString()} morceaux importés`, {
        description: lib.name,
      });
      setTimeout(() => {
        setProgress(null);
        navigate({ to: destinationAfterImport() });
        void startAnalysis();
      }, 400);
    } catch (err) {
      console.error(err);
      setProgress(null);
      toast.error("Import impossible", {
        description: "Vérifie que le dossier est accessible et réessaie.",
      });
    }
  }

  async function openLast() {
    if (await restoreLast()) {
      const lib = useLibraryStore.getState().library;
      if (lib && isCapacitorAndroid()) {
        await restoreFilesForLibrary(lib);
      }
      navigate({ to: destinationAfterImport() });
    }
  }

  const hasRecent = hydrated && !!lastMeta;

  return (
    <main className="min-h-[100dvh] bg-background">
      <input
        ref={inputRef}
        type="file"
        accept=".mp3,.wav,.flac,.aac,audio/*"
        multiple
        /* @ts-expect-error non-standard but widely supported attributes */
        webkitdirectory=""
        directory=""
        onChange={handleFiles}
        className="hidden"
      />
      <AudioPermissionDialog
        open={permissionDialog !== null}
        variant={permissionDialog ?? "request"}
        onCancel={() => setPermissionDialog(null)}
        onConfirm={() => void confirmAndroidPermission()}
        onOpenSettings={() => {
          setPermissionDialog(null);
          void openAndroidAppSettings();
        }}
      />

      {/* HERO */}
      <section className="relative overflow-hidden px-5 sm:px-6 pt-10 pb-8 safe-pt safe-px">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-24 h-72 opacity-60"
          style={{ background: "var(--gradient-hero, var(--gradient-primary))" }}
        />
        <div className="relative mx-auto flex w-full max-w-xl flex-col items-center text-center">
          <div className="mb-5 animate-fade-in motion-safe:[animation:float_6s_ease-in-out_infinite]">
            <img
              src={logoUrl}
              alt="TempoKey"
              className="h-[clamp(64px,18vw,88px)] w-[clamp(64px,18vw,88px)] rounded-2xl bg-white object-contain p-2"
              style={{ boxShadow: "var(--shadow-elegant)" }}
            />
          </div>
          <h1 className="font-display font-bold tracking-tight text-foreground text-[clamp(1.6rem,7vw,2.5rem)] leading-[1.05]">
            Analysez votre musique
            <br />
            en un dossier.
          </h1>
          <p className="mx-auto mt-3 w-full max-w-[min(94%,360px)] text-[clamp(12.5px,3.6vw,15px)] font-medium text-foreground/90 leading-snug text-balance">
            Sélectionnez un dossier contenant votre musique — TempoKey détecte
            automatiquement BPM, tonalités, notation Camelot et compatibilités
            de mix.
          </p>
          <p className="mx-auto mt-1.5 w-full max-w-[min(94%,340px)] text-[clamp(11px,3.2vw,13px)] text-muted-foreground leading-snug text-balance">
            100% local · hors connexion · zéro cloud.
          </p>

          <div className="mt-6 w-full max-w-[min(100%,340px)] space-y-3">
            <button
              onClick={pickFolder}
              className="press shine relative flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-2xl text-[clamp(13px,3.6vw,15px)] font-semibold text-[var(--primary-foreground)] animate-fade-in"
              style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-glow)" }}
            >
              <FolderSearch className="h-[18px] w-[18px] shrink-0" />
              <span className="truncate">Sélectionner un dossier à analyser</span>
            </button>
          </div>
        </div>
      </section>

      {/* RECENT LIBRARY CARD or ONBOARDING */}
      <section className="px-6">
        <div className="mx-auto max-w-xl">
          {hasRecent ? (
            <button
              onClick={openLast}
              className="group relative w-full overflow-hidden rounded-2xl border border-border bg-[var(--surface-elevated)] p-4 text-left transition-all hover:border-[var(--primary)]/40 hover:-translate-y-0.5"
              style={{ boxShadow: "var(--shadow-card)" }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 h-32 w-32 rounded-full opacity-20 blur-3xl transition-opacity group-hover:opacity-40"
                style={{ background: "var(--gradient-primary)" }}
              />
              <div className="relative flex items-center gap-3">
                <div
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-[var(--primary-foreground)]"
                  style={{ background: "var(--gradient-primary)" }}
                >
                  <Headphones className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Bibliothèque récente
                  </div>
                  <div className="truncate font-display text-base font-semibold text-foreground">
                    {lastMeta!.name}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                    {lastMeta!.trackCount.toLocaleString("fr-FR")} morceaux
                  </div>
                </div>
                <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
              </div>
            </button>
          ) : null}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="px-6 pt-10">
        <div className="mx-auto max-w-xl">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-display text-lg font-semibold tracking-tight">
              Comment ça fonctionne
            </h2>
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              3 étapes
            </span>
          </div>
          <ol className="space-y-2.5">
            {STEPS.map((s) => {
              const Icon = s.icon;
              return (
                <li
                  key={s.n}
                  className="hover-lift relative flex items-start gap-3 rounded-2xl border border-border bg-[var(--surface-elevated)] p-4"
                  style={{ boxShadow: "var(--shadow-card)" }}
                >
                  <div
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-[var(--primary-foreground)]"
                    style={{ background: "var(--gradient-primary)" }}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--accent)]">
                        Étape {s.n}
                      </span>
                    </div>
                    <div className="mt-0.5 text-sm font-semibold text-foreground">
                      {s.title}
                    </div>
                    <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {s.desc}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {/* CATEGORIES */}
      <section className="px-6 pt-10">
        <div className="mx-auto max-w-xl space-y-6">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-lg font-semibold tracking-tight">
              Fonctionnalités
            </h2>
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Tout en local
            </span>
          </div>
          {CATEGORIES.map((cat) => {
            const CatIcon = cat.icon;
            return (
              <div key={cat.label}>
                <div className="mb-2.5 flex items-center gap-2">
                  <span
                    className="grid h-7 w-7 place-items-center rounded-lg text-[var(--primary-foreground)]"
                    style={{ background: "var(--gradient-primary)" }}
                  >
                    <CatIcon className="h-3.5 w-3.5" />
                  </span>
                  <h3 className="font-display text-[15px] font-semibold tracking-tight">
                    {cat.label}
                  </h3>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  {cat.items.map((f) => {
                    const Icon = f.icon;
                    return (
                      <div
                        key={f.title}
                        className="hover-lift group rounded-xl border border-border bg-[var(--surface-elevated)] p-3 hover:border-[var(--primary)]/40"
                      >
                        <div
                          className="grid h-8 w-8 place-items-center rounded-lg text-[var(--accent)] transition-colors group-hover:text-[var(--primary-glow)]"
                          style={{
                            background:
                              "color-mix(in oklab, var(--accent) 12%, transparent)",
                          }}
                        >
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="mt-2 text-[13px] font-semibold text-foreground">
                          {f.title}
                        </div>
                        <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                          {f.desc}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* SMART RENAMING SPOTLIGHT */}
      <section className="px-6 pt-10">
        <div className="mx-auto max-w-xl">
          <div
            className="overflow-hidden rounded-2xl border border-border p-5"
            style={{
              background:
                "linear-gradient(135deg, color-mix(in oklab, var(--accent) 10%, var(--surface-elevated)), var(--surface-elevated))",
              boxShadow: "var(--shadow-card)",
            }}
          >
            <div className="flex items-center gap-2">
              <span
                className="grid h-8 w-8 place-items-center rounded-lg text-[var(--primary-foreground)]"
                style={{ background: "var(--gradient-primary)" }}
              >
                <FileSignature className="h-4 w-4" />
              </span>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--accent)]">
                  Renommage intelligent
                </div>
                <h2 className="font-display text-base font-semibold tracking-tight">
                  L'ordre du mix dans vos fichiers
                </h2>
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              TempoKey ajoute automatiquement des préfixes aux noms de fichiers
              pour conserver l'ordre de lecture directement dans l'explorateur
              et dans les lecteurs DJ.
            </p>
            <div className="mt-4 space-y-1.5 rounded-xl border border-border bg-[var(--surface)] p-3 font-mono text-[11px] leading-relaxed">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="opacity-60">avant</span>
                <span className="truncate">track_final_v2.mp3</span>
              </div>
              <div className="flex items-center gap-2 text-foreground">
                <span className="font-semibold text-[var(--accent)]">après</span>
                <span className="truncate">
                  <span className="text-[var(--primary-glow)]">01 — 124 BPM — 8A —</span>{" "}
                  track_final_v2.mp3
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* BENEFITS */}
      <section className="px-6 pt-10">
        <div className="mx-auto max-w-xl">
          <div
            className="rounded-2xl border border-border p-5"
            style={{
              background:
                "linear-gradient(135deg, color-mix(in oklab, var(--primary) 10%, var(--surface-elevated)), var(--surface-elevated))",
            }}
          >
            <h2 className="font-display text-base font-semibold tracking-tight">
              Pourquoi TempoKey
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Tout ce dont vous avez besoin pour préparer vos sets — sans cloud.
            </p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {BENEFITS.map((b) => {
                const Icon = b.icon;
                return (
                  <li
                    key={b.label}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-foreground"
                  >
                    <Icon className="h-3.5 w-3.5 text-[var(--accent)]" />
                    {b.label}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>

      {/* ADVANCED */}
      <section className="px-6 pt-10 pb-14">
        <div className="mx-auto max-w-xl">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-display text-lg font-semibold tracking-tight">
              Fonctionnalités avancées
            </h2>
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Pro
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {ADVANCED.map((a) => {
              const Icon = a.icon;
              return (
                <div
                  key={a.label}
                  className="hover-lift flex flex-col items-center gap-1.5 rounded-xl border border-border bg-[var(--surface-elevated)] p-3 text-center"
                >
                  <span
                    className="grid h-8 w-8 place-items-center rounded-lg text-[var(--accent)]"
                    style={{
                      background:
                        "color-mix(in oklab, var(--accent) 12%, transparent)",
                    }}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="text-[10.5px] font-medium leading-tight text-foreground">
                    {a.label}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-8 text-center text-[11px] text-muted-foreground">
            Vos fichiers ne quittent jamais votre appareil.
          </p>
        </div>
      </section>

      <ImportProgressModal progress={progress} />
    </main>
  );
}
