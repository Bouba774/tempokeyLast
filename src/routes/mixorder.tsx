import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ArrowLeft, Sparkles, Layers, Wand2 } from "lucide-react";
import { useLibraryStore } from "@/lib/library-store";
import { useMixOrderModeStore } from "@/lib/mixorder-mode-store";

/**
 * MixOrder entry point.
 *
 * PREPARATION-ONLY: this page is intentionally a placeholder shell. It
 * consumes the SAME shared stores as TempoKey (library-store, analysis-store,
 * ordering-store, cache) so that when MixOrder features are progressively
 * imported here, they operate on the exact same track model, library and
 * cache as the rest of TempoKey — no duplication, no divergence.
 */
export const Route = createFileRoute("/mixorder")({
  head: () => ({
    meta: [
      { title: "MixOrder — TempoKey" },
      {
        name: "description",
        content:
          "Point d'entrée MixOrder — fonctionnalités avancées de mix intelligent, partagées avec votre bibliothèque TempoKey.",
      },
    ],
  }),
  component: MixOrderPage,
});

function MixOrderPage() {
  const navigate = useNavigate();
  const library = useLibraryStore((s) => s.library);
  const hydrated = useLibraryStore((s) => s.hydrated);
  const hydrate = useLibraryStore((s) => s.hydrate);
  const enabled = useMixOrderModeStore((s) => s.enabled);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (hydrated && !library) {
      navigate({ to: "/" });
    }
  }, [hydrated, library, navigate]);

  return (
    <main className="min-h-[100dvh] bg-background safe-pt safe-px">
      <header className="mx-auto flex w-full max-w-xl items-center justify-between px-5 pt-4 pb-2">
        <Link
          to="/workspace"
          className="press inline-flex items-center gap-1.5 rounded-xl border border-border bg-[var(--surface-elevated)] px-3 py-2 text-xs font-medium text-foreground/90"
        >
          <ArrowLeft className="h-4 w-4" />
          Workspace TempoKey
        </Link>
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--accent)]">
          {enabled ? "Mode MixOrder actif" : "MixOrder"}
        </span>
      </header>

      <section className="mx-auto w-full max-w-xl px-5 pt-6 pb-10">
        <div
          className="rounded-2xl border border-border bg-[var(--surface-elevated)] p-5"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <div className="flex items-center gap-3">
            <div
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-[var(--primary-foreground)]"
              style={{ background: "var(--gradient-primary)" }}
            >
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="font-display text-lg font-semibold tracking-tight">
                MixOrder
              </h1>
              <p className="text-xs text-muted-foreground">
                Point d'entrée dédié — partage la bibliothèque et les analyses
                de TempoKey.
              </p>
            </div>
          </div>

          {library ? (
            <div className="mt-4 rounded-xl border border-border/70 bg-background/60 p-3 text-xs text-muted-foreground">
              Bibliothèque active :{" "}
              <span className="font-medium text-foreground">{library.name}</span>{" "}
              · {library.tracks.length.toLocaleString("fr-FR")} morceaux
            </div>
          ) : null}

          <ul className="mt-5 space-y-2.5">
            {[
              {
                icon: Layers,
                title: "Fonctionnalités MixOrder",
                desc: "Bientôt disponibles ici, sur la même bibliothèque que TempoKey.",
              },
              {
                icon: Wand2,
                title: "Zéro duplication de données",
                desc: "Aucune ré-importation nécessaire — tout est partagé.",
              },
            ].map((it) => {
              const Icon = it.icon;
              return (
                <li
                  key={it.title}
                  className="flex items-start gap-3 rounded-xl border border-border bg-background/40 p-3"
                >
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--surface-elevated)] text-foreground/80">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">
                      {it.title}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {it.desc}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </main>
  );
}