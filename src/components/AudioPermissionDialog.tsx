import { Music2, Settings2 } from "lucide-react";
import { useBackHandler } from "@/hooks/useBackHandler";

export type AudioPermissionDialogVariant = "request" | "denied" | "blocked";

type Props = {
  open: boolean;
  variant: AudioPermissionDialogVariant;
  onCancel: () => void;
  onConfirm: () => void;
  onOpenSettings?: () => void;
};

/**
 * Material 3-flavoured consent dialog shown before TempoKey triggers the
 * Android audio file picker. Three states:
 *  - "request": first time, explain why and ask Continue / Cancel.
 *  - "denied":  user declined once, offer Retry / Cancel.
 *  - "blocked": never-ask-again, offer Open settings / Cancel.
 */
export function AudioPermissionDialog({
  open,
  variant,
  onCancel,
  onConfirm,
  onOpenSettings,
}: Props) {
  useBackHandler(open, () => {
    onCancel();
    return true;
  });

  const isBlocked = variant === "blocked";
  const title =
    variant === "request"
      ? "Accès à la bibliothèque musicale"
      : "Accès refusé";
  const description =
    variant === "request"
      ? "TempoKey a besoin d'accéder à vos fichiers audio afin d'analyser les BPM, tonalités et organiser votre bibliothèque."
      : "TempoKey ne peut pas analyser votre bibliothèque sans accès aux fichiers audio.";

  const confirmLabel = isBlocked
    ? "Ouvrir les paramètres"
    : variant === "denied"
      ? "Réessayer"
      : "Continuer";

  if (!open) return null;

  return (
    <div
      className="android-fixed-layer fixed inset-0 z-50 grid place-items-center bg-background/80 px-5"
      role="presentation"
      data-tempokey-overlay="open"
    >
      <button
        type="button"
        aria-label="Annuler"
        onClick={onCancel}
        data-tempokey-close="true"
        className="absolute inset-0"
      />
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="audio-permission-title"
        aria-describedby="audio-permission-description"
        className="relative z-[51] w-full max-w-sm rounded-3xl border border-border bg-[var(--surface)] p-6 shadow-2xl"
      >
        <div className="flex flex-col space-y-2 text-center">
          <div className="mx-auto mb-2 grid h-12 w-12 place-items-center rounded-2xl bg-[var(--surface-elevated)] text-[var(--primary)]">
            {isBlocked ? (
              <Settings2 className="h-6 w-6" />
            ) : (
              <Music2 className="h-6 w-6" />
            )}
          </div>
          <h2 id="audio-permission-title" className="text-lg font-semibold">
            {title}
          </h2>
          <p id="audio-permission-description" className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => (isBlocked ? onOpenSettings?.() : onConfirm())}
            className="h-11 w-full rounded-2xl bg-[var(--primary)] px-4 text-sm font-semibold text-[var(--primary-foreground)]"
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="h-11 w-full rounded-2xl border border-border bg-[var(--surface-elevated)] px-4 text-sm font-semibold text-foreground"
          >
            Annuler
          </button>
        </div>
      </section>
    </div>
  );
}