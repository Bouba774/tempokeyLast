import type { BpmSourceDefinition, BpmSourceId } from "./types";

/**
 * Registry of BPM sources.
 *
 * New sources (DiscDJ auto, Essentia local fallback, MusicBrainz…) plug in
 * here without touching the analysis UI or the persistence layer.
 */
export const BPM_SOURCES: BpmSourceDefinition[] = [
  {
    id: "manual-discdj",
    label: "DiscDJ — saisie guidée",
    description:
      "Tu lis le BPM affiché dans DiscDJ pour le morceau courant et tu le saisis ici.",
    instructions:
      "Ouvre DiscDJ sur le même dossier audio. MixOrder t'affiche chaque morceau un par un ; saisis le BPM lu dans DiscDJ et passe au suivant.",
    available: true,
  },
  {
    id: "discdj-auto",
    label: "DiscDJ — robot",
    description:
      "MixOrder pilote DiscDJ : lit le BPM affiché puis appuie sur Suivant pour toi.",
    instructions:
      "Ouvre DiscDJ sur le même dossier et charge le premier morceau sur une platine. Choisis la platine ci-dessous et lance le robot — il lit le BPM, l'enregistre, puis passe au morceau suivant automatiquement.",
    available: true,
  },
  {
    id: "essentia",
    label: "Analyse locale",
    description: "Détection interne pour les morceaux inconnus de DiscDJ. Bientôt.",
    instructions: "Analyse tempo par traitement du signal (à venir).",
    available: false,
  },
];

export function getSource(id: BpmSourceId): BpmSourceDefinition | undefined {
  return BPM_SOURCES.find((s) => s.id === id);
}
