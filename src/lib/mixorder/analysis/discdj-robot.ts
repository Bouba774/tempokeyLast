import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace, type Track, type TrackId } from "@/lib/workspace-context";
import {
  getBridge,
  isPlausibleBpm,
  type DeckId,
  type DiscDJBridge,
  type DiscDJReading,
} from "./discdj-bridge";
import {
  CALIBRATION_SCREEN,
  getDeckCalibration,
  isDeckCalibrated,
  loadDiscDJSettings,
  saveDiscDJSettings,
  setCalibrationElement,
  type CalibrationPoint,
  type CalibrationRect,
  type CalibrationTarget,
  type DiscDJRobotSettings,
} from "./discdj-settings";

import {
  DURATION_TOLERANCE_SEC,
  findMatches,
  normalizeTitle,
  type MatchCandidate,
} from "./matching";
import {
  loadSnapshot,
  lookupAlias,
  projectFingerprint,
  rememberAlias,
  saveSnapshot,
  markRun,
} from "./persistence";
import type { AnalysisSnapshot } from "./types";
import { findBestMatch, normalizeTrackName, similarity } from "./name-normalize";

/**
 * DiscDJ analysis robot — headless orchestrator.
 *
 * Reading-driven loop: for every "Next" tap we read what DiscDJ shows on the
 * deck (title + duration + BPM), then match that reading against the
 * MixOrder library using the tolerant matcher in `./matching`. Order is
 * NEVER trusted — the library is the source of truth and we assign the BPM
 * to whichever track the reading identifies.
 *
 * Rules baked in here:
 *  - Tracks that already carry a BPM are skipped unless the user asks for
 *    a full re-analysis (`replaceExisting`).
 *  - A run stops early when the deck reports the end of the playlist or
 *    when nothing usable can be read.
 *  - Confident single matches are applied immediately. Ambiguous readings
 *    pause the loop, expose candidates on `state.pending`, and only resume
 *    after `resolvePending()` or `skipPending()`.
 *  - Every applied (or user-confirmed) match is remembered locally as an
 *    alias so future runs of the same project short-circuit the matcher.
 */

export type RobotPhase =
  | "idle"
  | "opening"
  | "reading"
  | "advancing"
  | "testing"
  | "awaiting-user" // ambiguous reading — waiting for a manual choice
  | "paused"
  | "done"
  | "error";

export type RobotLogLevel = "info" | "success" | "warning" | "error";

export interface RobotLogEntry {
  id: string;
  at: number;
  level: RobotLogLevel;
  message: string;
}

export interface PendingChoice {
  reading: DiscDJReading;
  candidates: MatchCandidate[];
}

export interface RunRecap {
  analyzedCount: number;
  needsRetryCount: number;
  foundBpms: Array<{ index: number; name: string; bpm: number; ocrName?: string; score?: number }>;
  missing: Array<{ index: number; name: string }>;
  /** AutoSync-name: tracks skipped because the OCR name couldn't be matched confidently. */
  toVerify?: Array<{ index: number; ocrName: string; bestGuess?: string; score: number; bpm: number | null }>;
}

export interface RobotState {
  phase: RobotPhase;
  deck: DeckId;
  bridgeLabel: string;
  settings: DiscDJRobotSettings;
  currentReading: DiscDJReading | null;
  /** Best-known track for the current reading (confident or user-picked). */
  currentTrack: Track | null;
  pending: PendingChoice | null;
  totalRun: number;
  doneInRun: number;
  skipped: number;
  /** Tracks that couldn't be OCR'd and were marked "à réanalyser". */
  needsRetryCount: number;
  errorMessage: string | null;
  lastError: string | null;
  logs: RobotLogEntry[];
  /** 1-based position in the library (auto-sync mode). */
  currentIndex: number;
  /** Total tracks in the current run's ordered window (auto-sync). */
  totalIndex: number;
  /** Estimated milliseconds remaining until the run completes. */
  etaMsRemaining: number | null;
  /** Set on `phase === "done"` — final summary shown to the user. */
  recap: RunRecap | null;
}

export interface StartOptions {
  /** When true, tracks that already carry a BPM are re-analysed too. */
  replaceExisting?: boolean;
  /** Hard cap on how many "Next" taps to perform in a run. Defaults to eligible × 2. */
  maxSteps?: number;
  /** Override the persisted start index (1-based). */
  startAtIndex?: number;
  /** Force resume from last saved position, ignoring `startAtIndex`. */
  resume?: boolean;
}

export function useDiscDJRobot() {
  const { project, setTrackAnalysis } = useWorkspace();
  const bridgeRef = useRef<DiscDJBridge>(getBridge());
  const settingsRef = useRef<DiscDJRobotSettings>(loadDiscDJSettings());

  const [state, setState] = useState<RobotState>(() => ({
    phase: "idle",
    deck: 1,
    bridgeLabel: bridgeRef.current.label,
    settings: settingsRef.current,
    currentReading: null,
    currentTrack: null,
    pending: null,
    totalRun: 0,
    doneInRun: 0,
    skipped: 0,
    needsRetryCount: 0,
    errorMessage: null,
    lastError: null,
    logs: [],
    currentIndex: 0,
    totalIndex: 0,
    etaMsRemaining: null,
    recap: null,
  }));

  const runIdRef = useRef(0);
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  /** Set of track ids that have received a BPM (or been explicitly skipped) during the current run. */
  const processedRef = useRef<Set<TrackId>>(new Set());
  /** Resolves the promise the loop awaits while `phase === "awaiting-user"`. */
  const pendingResolverRef = useRef<((v: TrackId | null) => void) | null>(null);

  const log = useCallback((level: RobotLogLevel, message: string) => {
    setState((s) => ({
      ...s,
      logs: [
        { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, at: Date.now(), level, message },
        ...s.logs,
      ].slice(0, 80),
    }));
  }, []);

  const updateSettings = useCallback((patch: Partial<DiscDJRobotSettings>) => {
    const next: DiscDJRobotSettings = {
      ...settingsRef.current,
      ...patch,
      calibration: patch.calibration ?? settingsRef.current.calibration,
    };
    settingsRef.current = next;
    saveDiscDJSettings(next);
    setState((s) => ({ ...s, settings: next }));
  }, []);

  const openAccessibilitySettings = useCallback(async () => {
    if (!bridgeRef.current.openAccessibilitySettings) return;
    await bridgeRef.current.openAccessibilitySettings();
  }, []);

  /**
   * Native accessibility status probe. Returns quickly and never throws so
   * the UI gate can poll it aggressively while the user toggles the switch
   * from Android's Accessibility settings.
   */
  const checkAccessibility = useCallback(async () => {
    try {
      const s = await bridgeRef.current.isReady();
      return {
        // On the simulated / web bridge we don't gate anything — treat as ok.
        native: bridgeRef.current.id !== "simulated",
        enabled: s.accessibilityEnabled !== false,
        discdjInstalled: s.discdjInstalled !== false,
        reason: s.reason ?? null,
      };
    } catch {
      return { native: bridgeRef.current.id !== "simulated", enabled: false, discdjInstalled: true, reason: null };
    }
  }, []);

  /** Whether the active bridge supports interactive in-DiscDJ capture. */
  const supportsDirectCapture = typeof bridgeRef.current.captureCalibration === "function";

  /** Persist a single calibration element (used by the screenshot editor). */
  const updateCalibrationElement = useCallback(
    (target: CalibrationTarget, value: Parameters<typeof setCalibrationElement>[2]) => {
      const next = setCalibrationElement(settingsRef.current, target, value);
      settingsRef.current = next;
      saveDiscDJSettings(next);
      setState((s) => ({ ...s, settings: next }));
    },
    [],
  );
  /**
   * Interactive calibration with **contextual navigation**.
   *
   * Each target lives on a specific DiscDJ screen (main or playlist).
   * Before showing the capture overlay we make sure DiscDJ is on the right
   * screen — otherwise the user is asked to touch a button that isn't even
   * visible. When calibrating the Back button we auto-tap Playlist first.
   *
   * After capture we immediately re-tap the recorded position (testTap) so
   * the coordinates that were saved are the coordinates that actually get
   * clicked at runtime. No horizontal/vertical offset, no scaling — the
   * point displayed, saved and clicked is strictly the same.
   */
  const captureCalibration = useCallback(
    async (target: CalibrationTarget): Promise<boolean> => {
      const bridge = bridgeRef.current;
      if (!bridge.captureCalibration) {
        log("error", "La calibration directe n'est pas disponible sur ce pont.");
        return false;
      }
      try {
        const screen = CALIBRATION_SCREEN[target];
        log("info", `Calibration « ${target} » (écran ${screen}) : ouverture de DiscDJ…`);
        await bridge.openApp();
        await sleep(settingsRef.current.waitOnOpenMs);

        // Contextual navigation — bring DiscDJ onto the screen where the
        // target actually lives before asking the user to touch it.
        if (screen === "playlist") {
          const playlistBtn = settingsRef.current.calibration.playlistButton;
          if (!playlistBtn) {
            log(
              "error",
              "Calibre d'abord le bouton Playlist (écran principal) : impossible d'atteindre la playlist sans lui.",
            );
            return false;
          }
          log("info", "Ouverture de la playlist DiscDJ…");
          await bridge.tapNext(1, { point: playlistBtn, pressDurationMs: settingsRef.current.pressDurationMs });
          await sleep(settingsRef.current.waitAfterPlaylistOpenMs);
        } else if (screen === "main") {
          // If we happen to be on the playlist and we know how to get back, do it.
          const backBtn = settingsRef.current.calibration.backButton;
          if (backBtn) {
            // Best-effort return to main. Harmless when we're already there.
            try {
              await bridge.tapNext(1, { point: backBtn, pressDurationMs: settingsRef.current.pressDurationMs });
              await sleep(settingsRef.current.waitAfterBackMs);
            } catch { /* ignore — we might already be on the main screen */ }
          }
        }

        const res = await bridge.captureCalibration(target);
        if (res.cancelled) {
          log("warning", "Calibration annulée.");
          return false;
        }
        const value = res.point ?? res.rect ?? null;
        if (!value) {
          log("warning", "Aucune position captée.");
          return false;
        }
        updateCalibrationElement(target, value);
        log("success", `Calibration enregistrée : ${target}.`);

        // Automatic self-check: replay the exact recorded point/rect as a
        // tap so any discrepancy between "recorded" and "clicked" is caught
        // immediately. Skipped for zones (BPM rectangles — nothing to tap).
        if (res.point) {
          try {
            log("info", "Vérification : clic de contrôle sur la position enregistrée…");
            await bridge.tapNext(1, { point: res.point, pressDurationMs: settingsRef.current.pressDurationMs });
            log(
              "success",
              `✅ Clic de contrôle effectué à x=${res.point.x.toFixed(3)} · y=${res.point.y.toFixed(3)}.`,
            );
          } catch (e) {
            log("error", `⚠️ Clic de contrôle refusé (${describe(e)}) — recommence la calibration.`);
            return false;
          }
        }
        return true;
      } catch (e) {
        log("error", `Calibration échouée : ${describe(e)}`);
        return false;
      }
    },
    [log, updateCalibrationElement],
  );

  /** True when the current run is delegated to the Android foreground service. */
  const backgroundRunRef = useRef(false);


  const stop = useCallback(() => {
    runIdRef.current += 1;
    pendingResolverRef.current?.(null);
    pendingResolverRef.current = null;
    if (backgroundRunRef.current && bridgeRef.current.stopBackgroundRun) {
      void bridgeRef.current.stopBackgroundRun();
      backgroundRunRef.current = false;
    }
    log("warning", "Analyse interrompue par l'utilisateur.");
    setState((s) => ({
      ...s,
      phase: s.phase === "done" ? "done" : "paused",
      pending: null,
    }));
  }, [log]);

  const pause = useCallback(() => {
    if (backgroundRunRef.current && bridgeRef.current.pauseBackgroundRun) {
      void bridgeRef.current.pauseBackgroundRun();
      setState((s) => ({ ...s, phase: "paused" }));
    }
  }, []);

  const resume = useCallback(() => {
    if (backgroundRunRef.current && bridgeRef.current.resumeBackgroundRun) {
      void bridgeRef.current.resumeBackgroundRun();
      setState((s) => ({ ...s, phase: "reading" }));
    }
  }, []);

  const clearBackgroundState = useCallback(async () => {
    await bridgeRef.current.clearBackgroundState?.();
  }, []);

  const getBackgroundStatus = useCallback(async () => {
    return bridgeRef.current.getBackgroundStatus?.() ?? null;
  }, []);

  // Subscribe to native service events (progress / BPM / logs / phase / done / visibility).
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge.addBackgroundListener) return;
    const subs: Array<{ remove: () => void }> = [];
    subs.push(bridge.addBackgroundListener("discdjBpm", (payload) => {
      const p = payload as { trackId?: string; bpm?: number; index?: number; total?: number };
      if (p?.trackId && typeof p.bpm === "number") {
        setTrackAnalysis(p.trackId as TrackId, { bpm: p.bpm }, "discdj-auto");
      }
      setState((s) => ({
        ...s,
        currentReading: { ...(s.currentReading ?? { bpm: null, title: null, durationSec: null }), bpm: p?.bpm ?? null },
        doneInRun: s.doneInRun + 1,
      }));
    }));
    subs.push(bridge.addBackgroundListener("discdjProgress", (payload) => {
      const p = payload as { index?: number; total?: number; etaMs?: number };
      setState((s) => ({
        ...s,
        currentIndex: p?.index ?? s.currentIndex,
        totalIndex: p?.total ?? s.totalIndex,
        etaMsRemaining: typeof p?.etaMs === "number" && p.etaMs >= 0 ? p.etaMs : s.etaMsRemaining,
      }));
    }));
    subs.push(bridge.addBackgroundListener("discdjPhase", (payload) => {
      const p = payload as { phase?: string };
      const phase = (p?.phase as RobotPhase | undefined) ?? "reading";
      setState((s) => ({ ...s, phase }));
    }));
    subs.push(bridge.addBackgroundListener("discdjLog", (payload) => {
      const p = payload as { level?: RobotLogLevel; message?: string };
      if (p?.message) log(p.level ?? "info", p.message);
    }));
    subs.push(bridge.addBackgroundListener("discdjDone", () => {
      backgroundRunRef.current = false;
      setState((s) => ({ ...s, phase: "done", etaMsRemaining: 0 }));
      log("success", "Analyse en arrière-plan terminée.");
    }));
    subs.push(bridge.addBackgroundListener("discdjVisibilityPaused", (payload) => {
      const p = payload as { visible?: boolean };
      if (p?.visible === false) {
        setState((s) => ({ ...s, phase: "paused", errorMessage: "DiscDJ n'est plus visible — rouvre-le pour continuer." }));
      } else {
        setState((s) => ({ ...s, phase: "reading", errorMessage: null }));
      }
    }));
    return () => { subs.forEach((s) => s.remove()); };
  }, [log, setTrackAnalysis]);


  const resolvePending = useCallback((trackId: TrackId) => {
    pendingResolverRef.current?.(trackId);
    pendingResolverRef.current = null;
  }, []);

  const skipPending = useCallback(() => {
    pendingResolverRef.current?.(null);
    pendingResolverRef.current = null;
  }, []);

  const start = useCallback(
    async (deck: DeckId, opts: StartOptions = {}) => {
      const p = projectRef.current;
      if (!p) return;

      const bridge = bridgeRef.current;
      const settings = settingsRef.current;
      if (!isDeckCalibrated(settings, deck)) {
        const message = `Calibration incomplète pour la platine ${deck}.`;
        log("error", message);
        setState((s) => ({ ...s, phase: "error", errorMessage: message }));
        return;
      }

      log("info", "Vérification du robot DiscDJ…");
      const readiness = await bridge.isReady();
      if (!readiness.ready) {
        log("error", readiness.reason ?? "Pont DiscDJ indisponible.");
        setState((s) => ({
          ...s,
          phase: "error",
          errorMessage: readiness.reason ?? "Bridge indisponible.",
        }));
        return;
      }

      const replaceExisting = opts.replaceExisting ?? settings.replaceExisting;
      const skipAlreadyBpm = settings.skipAlreadyBpm && !replaceExisting;
      const fingerprint = projectFingerprint(p);
      let snapshot = loadSnapshot(fingerprint);

      // Determine the ordered window of tracks to work through.
      // Auto-sync assumes MixOrder library ↔ DiscDJ playlist are aligned:
      // read the deck once per track, in order, without ever leaving DiscDJ.
      const ordered = p.tracks;
      let startIdx = Math.min(
        Math.max(0, (opts.startAtIndex ?? settings.startAtIndex) - 1),
        Math.max(0, ordered.length - 1),
      );
      if ((opts.resume ?? settings.autoResume) && snapshot?.currentRun?.lastPath) {
        const lastIdx = ordered.findIndex((t) => t.path === snapshot!.currentRun!.lastPath);
        if (lastIdx >= 0 && lastIdx + 1 < ordered.length) {
          startIdx = lastIdx + 1;
          log("info", `Reprise automatique : redémarrage au morceau n°${startIdx + 1}.`);
        }
      }
      const window = ordered.slice(startIdx);
      const eligibleTracks = window.filter((t) => (replaceExisting ? true : t.bpm === null));

      if (eligibleTracks.length === 0) {
        log("success", "Aucun morceau à analyser : tous les BPM sont déjà présents.");
        setState((s) => ({ ...s, phase: "done", totalRun: 0, doneInRun: 0, skipped: 0 }));
        return;
      }

      processedRef.current = new Set();
      const runId = ++runIdRef.current;
      const maxSteps = opts.maxSteps ?? Math.max(eligibleTracks.length * 2, p.tracks.length);

      setState((s) => ({
        ...s,
        phase: "opening",
        deck,
        bridgeLabel: bridge.label,
        settings,
        currentReading: null,
        currentTrack: null,
        pending: null,
        totalRun: settings.analysisMode === "auto-sync" ? window.length : eligibleTracks.length,
        doneInRun: 0,
        skipped: 0,
        needsRetryCount: 0,
        errorMessage: null,
        lastError: null,
        currentIndex: startIdx + 1,
        totalIndex: ordered.length,
        etaMsRemaining: null,
        recap: null,
      }));

      // ---------- BACKGROUND (Foreground Service) DELEGATION ----------
      if (
        settings.runInBackground &&
        (settings.analysisMode === "auto-sync" || settings.analysisMode === "autosync-name") &&
        bridge.startBackgroundRun
      ) {
        const cal = getDeckCalibration(settings, deck);
        const nameZone = deck === 1 ? settings.calibration.nameZoneDeck1 : settings.calibration.nameZoneDeck2;
        if (settings.analysisMode === "autosync-name") {
          const missingCal: string[] = [];
          if (!settings.calibration.playlistButton) missingCal.push("bouton Playlist");
          if (!settings.calibration.backButton) missingCal.push("bouton Retour");
          if (!nameZone) missingCal.push(`zone Nom du morceau platine ${deck}`);
          if (missingCal.length > 0) {
            const msg = `Calibration AutoSync incomplète : ${missingCal.join(", ")}.`;
            log("error", msg);
            setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
            return;
          }
        }
        const bgTracks = ordered.slice(startIdx).map((t) => ({
          id: t.id,
          path: t.path,
          name: t.name,
          originalName: t.originalName,
          hasBpm: t.bpm != null,
        }));
        try {
          backgroundRunRef.current = true;
          await bridge.startBackgroundRun({
            analysisMode: settings.analysisMode,
            deck,
            startIndex: 0,
            projectFingerprint: fingerprint,
            projectName: p.name,
            tracks: bgTracks,
            nextPoint: cal.next,
            bpmZone: cal.bpmZone,
            playlistButton: settings.analysisMode === "autosync-name" ? settings.calibration.playlistButton : null,
            backButton: settings.analysisMode === "autosync-name" ? settings.calibration.backButton : null,
            nameZone: settings.analysisMode === "autosync-name" ? nameZone : null,
            skipAlreadyBpm,
            replaceExisting,
            waitOnOpenMs: settings.waitOnOpenMs,
            waitBeforeReadMs: settings.waitBeforeReadMs,
            waitAfterClickMs: settings.waitAfterClickMs,
            waitAfterPlaylistOpenMs: settings.waitAfterPlaylistOpenMs,
            waitAfterBackMs: settings.waitAfterBackMs,
            pressDurationMs: settings.pressDurationMs,
            maxAttempts: settings.maxAttempts,
            nameMaxOcrRetries: settings.nameMaxOcrRetries,
          });
          log("success", "Service d'arrière-plan démarré — l'analyse continue même si MixOrder est fermé.");
          setState((s) => ({ ...s, phase: "reading" }));
          return;
        } catch (e) {
          backgroundRunRef.current = false;
          log("warning", `Service d'arrière-plan indisponible : ${describe(e)} — bascule sur la boucle intégrée.`);
        }
      }


      try {
        log("info", "Ouverture de DiscDJ…");
        await bridge.openApp();
        log("success", "DiscDJ est au premier plan.");
        if (settings.waitOnOpenMs > 0) {
          log("info", `Attente de chargement à l'ouverture : ${settings.waitOnOpenMs} ms…`);
          await sleep(settings.waitOnOpenMs);
        }
      } catch (e) {
        log("warning", `Ouverture DiscDJ non confirmée : ${describe(e)}`);
        setState((s) => ({ ...s, lastError: describe(e) }));
      }
      const preflight = await checkAnalysisPreflight(bridge, deck, settings, log);
      if (!preflight.ok) {
        const message = preflight.reason ?? "DiscDJ n'est pas prêt pour une capture OCR fiable.";
        log("error", message);
        setState((s) => ({ ...s, phase: "error", errorMessage: message, lastError: message }));
        return;
      }

      const cal = getDeckCalibration(settings, deck);

      // ---------- AUTOSYNC (name-checked) — SIMPLE STATE MACHINE ----------
      // Per track, in strict order:
      //   1. ensure DiscDJ has the foreground
      //   2. read BPM (single OCR)          → retry if unreadable
      //   3. tap Playlist, wait
      //   4. OCR the calibrated name zone, clean, match against library
      //   5. if BPM + match → persist, tap Back, tap Next, next track
      //      else → tap Back and retry the whole step
      //   6. after N failed attempts → mark "à réanalyser" and keep alignment
      //
      // No votes, no quorums, no confidence gymnastics. Progress is
      // persisted after every track so the run resumes cleanly after any
      // interruption (focus loss, DiscDJ crash, MixOrder reopen).
      if (settings.analysisMode === "autosync-name") {
        const playlistBtn = settings.calibration.playlistButton;
        const backBtn = settings.calibration.backButton;
        const nameZone = deck === 1 ? settings.calibration.nameZoneDeck1 : settings.calibration.nameZoneDeck2;
        const missingCal: string[] = [];
        if (!cal.next) missingCal.push(`bouton Next platine ${deck}`);
        if (!cal.bpmZone) missingCal.push(`zone BPM platine ${deck}`);
        if (!playlistBtn) missingCal.push("bouton Playlist");
        if (!backBtn) missingCal.push("bouton Retour");
        if (!nameZone) missingCal.push(`zone Nom du morceau platine ${deck}`);
        if (missingCal.length > 0) {
          const msg = `Calibration AutoSync incomplète : ${missingCal.join(", ")}.`;
          log("error", msg);
          setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
          return;
        }

        const runStartedAt = Date.now();
        const foundBpms: RunRecap["foundBpms"] = [];
        const missing: RunRecap["missing"] = [];
        const toVerify: NonNullable<RunRecap["toVerify"]> = [];
        const threshold = settings.nameMatchThreshold;
        const total = ordered.length - startIdx;
        const perStepMaxRetries = Math.max(1, settings.nameMaxOcrRetries);
        setState((s) => ({ ...s, totalRun: total }));

        for (let i = startIdx; i < ordered.length; i++) {
          if (runIdRef.current !== runId) return;
          const positionLabel = `${i + 1}/${ordered.length}`;
          const progress = `[${positionLabel}]`;

          setState((s) => ({
            ...s,
            phase: "reading",
            currentIndex: i + 1,
            currentReading: null,
            currentTrack: null,
          }));
          log("info", `${progress} Morceau en cours.`);

          let matched: Track | null = null;
          let matchedBpm: number | null = null;
          let lastOcr = "";

          for (let attempt = 1; attempt <= perStepMaxRetries; attempt++) {
            if (runIdRef.current !== runId) return;

            // 1. Ensure DiscDJ is at the foreground before every touch/read.
            await ensureDiscDJForeground(bridge, log);
            if (runIdRef.current !== runId) return;

            // 2. Read BPM once. On failure, retry the whole step.
            const bpm = await readBpmOnce(bridge, deck, cal.bpmZone!, settings);
            if (runIdRef.current !== runId) return;
            if (bpm == null) {
              log("warning", `${progress} BPM illisible — nouvelle tentative.`);
              await bgSleep(bridge, 500);
              continue;
            }

            // 3. Open the playlist.
            setState((s) => ({ ...s, phase: "advancing" }));
            try {
              await bridge.tapNext(deck, { point: playlistBtn, pressDurationMs: settings.pressDurationMs });
            } catch { /* handled by retry loop */ }
            await bgSleep(bridge, settings.waitAfterPlaylistOpenMs);
            if (runIdRef.current !== runId) return;
            await ensureDiscDJForeground(bridge, log);

            // 4. OCR the calibrated name zone.
            const nameRead = await readAndCleanNameOnce(bridge, deck, nameZone!);
            const { cleaned } = nameRead;
            lastOcr = cleaned;
            if (!cleaned) {
              log("warning", `${progress} Nom illisible — retour et nouvelle tentative.`);
              if (!(await returnToMainStrict(bridge, deck, backBtn!, settings))) {
                const msg = `${progress} Retour écran principal refusé — analyse arrêtée pour éviter un décalage.`;
                log("error", msg);
                setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
                return;
              }
              continue;
            }

            // 5. Match against the imported library. Because AutoSync is an
            //    ordered workflow, the expected MixOrder row is allowed to
            //    resolve OCR ambiguity when its name is compatible. This
            //    prevents false “aucun morceau” stops on partial/scrolling OCR
            //    while still falling back to a global match when the playlist
            //    is actually offset.
            const match = resolveAutoSyncNameMatch(nameRead.candidates, ordered, ordered[i], threshold);
            if (!match.track) {
              const dbg = match.best
                ? ` (meilleur candidat: « ${match.best.track.name} » ${(match.best.score * 100).toFixed(0)}%)`
                : "";
              log("warning", `${progress} Aucun morceau MixOrder ne correspond à « ${cleaned} »${dbg}.`);
              if (!(await returnToMainStrict(bridge, deck, backBtn!, settings))) {
                const msg = `${progress} Retour écran principal refusé — analyse arrêtée pour éviter un décalage.`;
                log("error", msg);
                setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
                return;
              }
              continue;
            }

            // 6. Persist BPM immediately, then go back to main.
            matched = match.track;
            matchedBpm = bpm;
            setTrackAnalysis(matched.id, { bpm }, "discdj-auto");
            processedRef.current.add(matched.id);
            foundBpms.push({ index: i + 1, name: matched.name, bpm, ocrName: cleaned, score: match.score });
            snapshot = markRun(
              snapshot ?? { v: 1, name: p.name, tracks: {} },
              p.name,
              { sourceId: "discdj-auto", startedAt: runStartedAt, lastPath: matched.path },
            );
            snapshot = rememberAlias(snapshot, p.name, normalizeTitle(cleaned), matched.path);
            saveSnapshot(fingerprint, snapshot);

            log("success", `${progress} BPM ${bpm} · « ${cleaned} » → « ${matched.name} » ✓`);
            setState((s) => ({
              ...s,
              currentTrack: matched,
              currentReading: { bpm, title: cleaned, durationSec: null },
              doneInRun: processedRef.current.size,
            }));

            if (!(await returnToMainStrict(bridge, deck, backBtn!, settings))) {
              const msg = `${progress} Retour écran principal refusé — BPM enregistré, analyse arrêtée pour éviter un décalage.`;
              log("error", msg);
              setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
              return;
            }
            break;
          }

          if (!matched) {
            const reason = lastOcr
              ? `Aucun morceau MixOrder ne correspond à « ${lastOcr} »`
              : "Nom illisible après plusieurs tentatives";
            log("error", `${progress} ${reason} — marqué à réanalyser.`);
            toVerify.push({ index: i + 1, ocrName: lastOcr, bpm: matchedBpm, score: 0 });
            setState((s) => ({ ...s, needsRetryCount: s.needsRetryCount + 1 }));
            // Save progress even for a failed step so a resume starts fresh
            // on the *next* track rather than replaying the failed one.
            snapshot = markRun(
              snapshot ?? { v: 1, name: p.name, tracks: {} },
              p.name,
              { sourceId: "discdj-auto", startedAt: runStartedAt, lastPath: ordered[i].path },
            );
            saveSnapshot(fingerprint, snapshot);
            // Make sure we're back on main before tapping Next.
            if (!(await returnToMainStrict(bridge, deck, backBtn!, settings))) {
              const msg = `${progress} Retour écran principal refusé — analyse arrêtée pour éviter un décalage.`;
              log("error", msg);
              setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
              return;
            }
          }

          if (i + 1 >= ordered.length) break;

          // Advance DiscDJ to the next track. Never leave without tapping
          // Next — otherwise a failed step would desync the whole run.
          await ensureDiscDJForeground(bridge, log);
          try {
            await bridge.tapNext(deck, { point: cal.next, pressDurationMs: settings.pressDurationMs });
          } catch {
            await bgSleep(bridge, 500);
            try { await bridge.tapNext(deck, { point: cal.next, pressDurationMs: settings.pressDurationMs }); } catch { /* ignore */ }
          }
          await bgSleep(bridge, settings.waitAfterClickMs);
        }

        if (snapshot) {
          snapshot = markRun(snapshot, p.name, undefined);
          saveSnapshot(fingerprint, snapshot);
        }

        const recap: RunRecap = {
          analyzedCount: foundBpms.length,
          needsRetryCount: missing.length + toVerify.length,
          foundBpms,
          missing,
          toVerify,
        };
        log("success", `AutoSync terminé : ${foundBpms.length}/${total} morceaux associés · ${toVerify.length} à vérifier.`);
        setState((s) => ({
          ...s,
          phase: "done",
          pending: null,
          doneInRun: processedRef.current.size,
          etaMsRemaining: 0,
          recap,
        }));
        return;
      }




      // ---------- AUTO-SYNC MODE ----------
      // Deterministic order: DiscDJ position `i` ALWAYS corresponds to
      // library track `i`. We never re-order based on OCR success. If a
      // BPM can't be read we mark the track "à réanalyser" and still
      // advance to the next one so the sequence stays aligned.
      if (settings.analysisMode === "auto-sync") {
        const stepStartedAt: number[] = [];
        const runStartedAt = Date.now();
        const foundBpms: RunRecap["foundBpms"] = [];
        const missing: RunRecap["missing"] = [];

        for (let i = startIdx; i < ordered.length; i++) {
          if (runIdRef.current !== runId) return;
          const track = ordered[i];
          const stepStart = Date.now();
          const positionLabel = `${i + 1}/${ordered.length}`;

          setState((s) => ({
            ...s,
            phase: "reading",
            currentIndex: i + 1,
            currentTrack: track,
            currentReading: null,
          }));

          let processedThisStep = false;

          if (skipAlreadyBpm && track.bpm != null) {
            log("info", `Morceau ${positionLabel} « ${track.name} » : BPM déjà présent, ignoré.`);
            setState((s) => ({ ...s, skipped: s.skipped + 1 }));
            processedThisStep = true;
          } else {
            // Wait for the track to actually be ready before OCR — minimum
            // configured delay from the previous Next tap. (First iteration
            // gets waitOnOpenMs which was already applied above.)
            if (i > startIdx && settings.minReadyDelayMs > 0) {
              await sleep(settings.minReadyDelayMs);
            }
            if (runIdRef.current !== runId) return;

            // Vote-based BPM reading: up to bpmMaxAttempts OCR passes,
            // early exit as soon as `bpmValidVoteCount` identical valid
            // readings (40 ≤ BPM ≤ 240) have been collected.
            const voted = await readBpmWithVote(bridge, deck, settings, log, positionLabel, () => runIdRef.current === runId);
            if (runIdRef.current !== runId) return;
            const reading = voted.reading;
            setState((s) => ({ ...s, currentReading: reading }));

            if (reading.endOfPlaylist) {
              log("success", "Fin de playlist DiscDJ détectée.");
              break;
            }

            if (voted.bpm != null) {
              // Persist BEFORE tapping Next — the invariant is: never
              // advance until the current track's BPM has been saved.
              setTrackAnalysis(track.id, { bpm: voted.bpm }, "discdj-auto");
              processedRef.current.add(track.id);
              foundBpms.push({ index: i + 1, name: track.name, bpm: voted.bpm });
              if (settings.autosaveEachStep) {
                snapshot = markRun(
                  snapshot ?? { v: 1, name: p.name, tracks: {} },
                  p.name,
                  { sourceId: "discdj-auto", startedAt: runStartedAt, lastPath: track.path },
                );
                if (reading.title) {
                  snapshot = rememberAlias(snapshot, p.name, normalizeTitle(reading.title), track.path);
                }
                saveSnapshot(fingerprint, snapshot);
              }
              log(
                "success",
                `Morceau ${positionLabel} « ${track.name} » : BPM ${voted.bpm} enregistré (vote ×${voted.voteCount} sur ${voted.attempts} tentatives).`,
              );
              setState((s) => ({ ...s, doneInRun: processedRef.current.size }));
              processedThisStep = true;
            } else {
              // OCR failed after every attempt — mark the track and keep
              // the sequence aligned by still tapping Next.
              missing.push({ index: i + 1, name: track.name });
              const reason = reading.parseReason ?? "BPM illisible après plusieurs tentatives.";
              log(
                "warning",
                `Morceau ${positionLabel} « ${track.name} » : marqué « À réanalyser » (${reason}).`,
              );
              // Persist the "needs re-analysis" hint on the snapshot so the
              // user can filter these tracks later.
              const snap = snapshot ?? { v: 1 as const, name: p.name, tracks: {} };
              snapshot = {
                ...snap,
                tracks: {
                  ...snap.tracks,
                  [track.path]: {
                    ...(snap.tracks[track.path] ?? { bpm: null, musicalKey: null, updatedAt: Date.now(), source: "discdj-auto" }),
                    needsReanalysis: true,
                    updatedAt: Date.now(),
                    source: "discdj-auto",
                  },
                },
              };
              if (settings.autosaveEachStep) saveSnapshot(fingerprint, snapshot);
              setState((s) => ({ ...s, needsRetryCount: s.needsRetryCount + 1 }));
              processedThisStep = true;
            }
          }

          // ETA — rolling average of the last 5 steps.
          stepStartedAt.push(Date.now() - stepStart);
          const recent = stepStartedAt.slice(-5);
          const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
          const remaining = ordered.length - (i + 1);
          setState((s) => ({ ...s, etaMsRemaining: remaining > 0 ? Math.round(avg * remaining) : 0 }));

          if (!processedThisStep) continue; // safety — should never trigger
          if (i + 1 >= ordered.length) break;

          setState((s) => ({ ...s, phase: "advancing" }));
          try {
            await bridge.tapNext(deck, { point: cal.next, pressDurationMs: settings.pressDurationMs });
          } catch (e) {
            const message = describe(e);
            log("warning", `Clic Next échoué (${message}) — nouvelle tentative après une courte pause.`);
            await sleep(600);
            try {
              await bridge.tapNext(deck, { point: cal.next, pressDurationMs: settings.pressDurationMs });
            } catch (e2) {
              log("error", `Second clic Next échoué (${describe(e2)}) — la boucle continue au morceau suivant.`);
              setState((s) => ({ ...s, lastError: describe(e2) }));
            }
          }
          await sleep(settings.waitAfterClickMs);
          if (runIdRef.current !== runId) return;
        }


        // Clear resume marker on clean completion.
        if (snapshot) {
          snapshot = markRun(snapshot, p.name, undefined);
          saveSnapshot(fingerprint, snapshot);
        }

        const recap: RunRecap = {
          analyzedCount: foundBpms.length,
          needsRetryCount: missing.length,
          foundBpms,
          missing,
        };
        log(
          "success",
          `Analyse terminée : ${recap.analyzedCount} morceau(x) analysé(s), ${recap.needsRetryCount} à réanalyser.`,
        );
        setState((s) => ({
          ...s,
          phase: "done",
          pending: null,
          doneInRun: processedRef.current.size,
          etaMsRemaining: 0,
          recap,
        }));
        return;
      }


      // ---------- VERIFICATION MODE (existing smart matching) ----------

      // Boucle intelligente : lire l'écran DiscDJ → identifier le morceau par nom + durée → associer le BPM.
      // L'ordre de la bibliothèque n'est jamais utilisé comme preuve d'identité.
      for (let step = 0; step < maxSteps; step++) {
        if (runIdRef.current !== runId) return;
        const remaining = eligibleTracks.filter((t) => !processedRef.current.has(t.id));
        if (remaining.length === 0) break;

        setState((s) => ({ ...s, phase: "reading", currentReading: null, currentTrack: null }));
        log("info", `Lecture DiscDJ ${step + 1}/${maxSteps} — identification par nom affiché + durée…`);

        let reading = emptyReading();
        try {
          reading = await readSmartDeck(bridge, deck, settings, {}, log);
        } catch (e) {
          log("warning", `Lecture impossible : ${describe(e)}`);
          setState((s) => ({ ...s, lastError: describe(e) }));
        }
        if (runIdRef.current !== runId) return;
        setState((s) => ({ ...s, currentReading: reading }));

        if (reading.endOfPlaylist) {
          log("success", "Fin de playlist DiscDJ détectée.");
          break;
        }

        if (!isPlausibleBpm(reading.bpm)) {
          const reason = reading.parseReason ?? "BPM illisible dans la zone calibrée";
          log("warning", `BPM non retenu : ${reason}`);
          setState((s) => ({ ...s, skipped: s.skipped + 1 }));
        } else {
          const match = resolveReadingMatch(reading, remaining, snapshot);
          let chosen: Track | null = match.track;

          if (!chosen && match.candidates.length > 0) {
            log("warning", "Correspondance ambiguë : choix manuel requis avant d'associer le BPM.");
            const picked = await waitForManualChoice(reading, match.candidates, setState, pendingResolverRef);
            if (runIdRef.current !== runId) return;
            chosen = match.candidates.find((c) => c.track.id === picked)?.track ?? null;
            setState((s) => ({ ...s, pending: null, phase: "reading" }));
          }

          if (chosen) {
            setTrackAnalysis(chosen.id, { bpm: reading.bpm }, "discdj-auto");
            processedRef.current.add(chosen.id);
            if (reading.title) {
              snapshot = rememberAlias(snapshot, p.name, normalizeTitle(reading.title), chosen.path);
              saveSnapshot(fingerprint, snapshot);
            }
            log("success", `BPM ${reading.bpm} associé à « ${chosen.name} » après validation nom + durée.`);
            setState((s) => ({ ...s, currentTrack: chosen, doneInRun: processedRef.current.size }));
          } else {
            log("warning", `BPM ${reading.bpm} ignoré : aucun morceau MixOrder identifié avec certitude${reading.title ? ` pour « ${reading.title} »` : ""}.`);
            setState((s) => ({ ...s, skipped: s.skipped + 1 }));
          }
        }

        if (processedRef.current.size >= eligibleTracks.length) break;

        setState((s) => ({ ...s, phase: "advancing" }));
        log("info", "Clic Next → morceau DiscDJ suivant…");
        try {
          await bridge.tapNext(deck, {
            point: cal.next,
            pressDurationMs: settings.pressDurationMs,
          });
        } catch (e) {
          const message = describe(e);
          log("error", `Clic Next échoué : ${message}`);
          setState((s) => ({ ...s, phase: "error", errorMessage: message, lastError: message }));
          return;
        }
        log("info", `Attente ${settings.waitAfterClickMs} ms pour laisser le morceau suivant se charger…`);
        await sleep(settings.waitAfterClickMs);
        if (runIdRef.current !== runId) return;
      }

      log("success", "Analyse DiscDJ terminée.");
      setState((s) => ({
        ...s,
        phase: "done",
        pending: null,
        doneInRun: processedRef.current.size,
      }));
    },
    [log, setTrackAnalysis],
  );

  const testRead = useCallback(async (deck: DeckId): Promise<DiscDJReading | null> => {
    const settings = settingsRef.current;
    if (!isDeckCalibrated(settings, deck)) {
      log("error", `Calibration incomplète pour la platine ${deck}.`);
      return null;
    }
    setState((s) => ({ ...s, phase: "testing", deck }));
    try {
      log("info", `Test lecture BPM platine ${deck}…`);
      try {
        await bridgeRef.current.openApp();
        if (settings.waitOnOpenMs > 0) {
          log("info", `Attente de chargement à l'ouverture : ${settings.waitOnOpenMs} ms…`);
          await sleep(settings.waitOnOpenMs);
        }
      } catch { /* ignore — bridge may not require openApp */ }
      const preflight = await checkAnalysisPreflight(bridgeRef.current, deck, settings, log);
      if (!preflight.ok) {
        const message = preflight.reason ?? "Pré-vérification DiscDJ échouée.";
        log("error", message);
        setState((s) => ({ ...s, phase: "error", errorMessage: message }));
        return null;
      }
      const reading = await readSmartDeck(bridgeRef.current, deck, settings, {}, log);
      setState((s) => ({ ...s, currentReading: reading, phase: "idle" }));
      if (isPlausibleBpm(reading.bpm)) {
        log("success", `Test lecture réussi : BPM ${reading.bpm}${reading.title ? ` · ${reading.title}` : ""}`);
      } else {
        log("warning", "Test lecture terminé sans BPM détecté.");
      }
      return reading;
    } catch (e) {
      const message = describe(e);
      log("error", `Test lecture échoué : ${message}`);
      setState((s) => ({ ...s, phase: "error", errorMessage: message }));
      return null;
    }
  }, [log]);

  const testClick = useCallback(async (deck: DeckId): Promise<{ changed: boolean; message: string }> => {
    const settings = settingsRef.current;
    if (!isDeckCalibrated(settings, deck)) {
      log("error", `Calibration incomplète pour la platine ${deck}.`);
      return { changed: false, message: `Calibration incomplète pour la platine ${deck}.` };
    }
    setState((s) => ({ ...s, phase: "testing", deck }));
    try {
      log("info", `Test clic Next platine ${deck}…`);
      await bridgeRef.current.openApp();
      if (settings.waitOnOpenMs > 0) {
        log("info", `Attente de chargement à l'ouverture : ${settings.waitOnOpenMs} ms…`);
        await sleep(settings.waitOnOpenMs);
      }
      const cal = getDeckCalibration(settings, deck);
      await bridgeRef.current.tapNext(deck, {
        point: cal.next,
        pressDurationMs: settings.pressDurationMs,
      });
      log("success", "Geste Next envoyé.");
      await sleep(settings.waitAfterClickMs);
      setState((s) => ({ ...s, phase: "idle" }));
      return {
        changed: true,
        message: "Geste Next envoyé — vérifie visuellement dans DiscDJ que le morceau a changé.",
      };
    } catch (e) {
      const message = describe(e);
      log("error", `Test clic échoué : ${message}`);
      setState((s) => ({ ...s, phase: "error", errorMessage: message }));
      return { changed: false, message };
    }
  }, [log]);

  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      pendingResolverRef.current?.(null);
      pendingResolverRef.current = null;
    };
  }, []);

  const testPlaylistButton = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    const settings = settingsRef.current;
    const point = settings.calibration.playlistButton;
    if (!point) return { ok: false, message: "Bouton Playlist non calibré." };
    setState((s) => ({ ...s, phase: "testing" }));
    try {
      log("info", "Test bouton Playlist : ouverture de DiscDJ…");
      await bridgeRef.current.openApp();
      await sleep(settings.waitOnOpenMs);
      await bridgeRef.current.tapNext(1, { point, pressDurationMs: settings.pressDurationMs });
      await sleep(settings.waitAfterPlaylistOpenMs);
      setState((s) => ({ ...s, phase: "idle" }));
      const msg = "Clic Playlist envoyé — vérifie que l'écran playlist est bien affiché dans DiscDJ.";
      log("success", msg);
      return { ok: true, message: msg };
    } catch (e) {
      const message = describe(e);
      log("error", `Test bouton Playlist échoué : ${message}`);
      setState((s) => ({ ...s, phase: "error", errorMessage: message }));
      return { ok: false, message };
    }
  }, [log]);

  const testBackButton = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    const settings = settingsRef.current;
    const playlist = settings.calibration.playlistButton;
    const back = settings.calibration.backButton;
    if (!back) return { ok: false, message: "Bouton Retour non calibré." };
    setState((s) => ({ ...s, phase: "testing" }));
    try {
      log("info", "Test bouton Retour : préparation depuis l'écran playlist…");
      await bridgeRef.current.openApp();
      await sleep(settings.waitOnOpenMs);
      if (playlist) {
        await bridgeRef.current.tapNext(1, { point: playlist, pressDurationMs: settings.pressDurationMs });
        await sleep(settings.waitAfterPlaylistOpenMs);
      }
      await bridgeRef.current.tapNext(1, { point: back, pressDurationMs: settings.pressDurationMs });
      await sleep(settings.waitAfterBackMs);
      setState((s) => ({ ...s, phase: "idle" }));
      const msg = "Clic Retour envoyé — vérifie que l'écran principal est bien affiché.";
      log("success", msg);
      return { ok: true, message: msg };
    } catch (e) {
      const message = describe(e);
      log("error", `Test bouton Retour échoué : ${message}`);
      setState((s) => ({ ...s, phase: "error", errorMessage: message }));
      return { ok: false, message };
    }
  }, [log]);

  const testNameZone = useCallback(
    async (deck: DeckId): Promise<{ ok: boolean; raw: string; cleaned: string; message: string }> => {
      const settings = settingsRef.current;
      const zone = deck === 1 ? settings.calibration.nameZoneDeck1 : settings.calibration.nameZoneDeck2;
      const playlist = settings.calibration.playlistButton;
      const back = settings.calibration.backButton;
      if (!zone) return { ok: false, raw: "", cleaned: "", message: `Zone nom du morceau platine ${deck} non calibrée.` };
      if (!playlist) return { ok: false, raw: "", cleaned: "", message: "Bouton Playlist non calibré." };
      setState((s) => ({ ...s, phase: "testing", deck }));
      try {
        log("info", `Test zone Nom platine ${deck} : ouverture playlist…`);
        await bridgeRef.current.openApp();
        await sleep(settings.waitOnOpenMs);
        await bridgeRef.current.tapNext(deck, { point: playlist, pressDurationMs: settings.pressDurationMs });
        await sleep(settings.waitAfterPlaylistOpenMs);
        const { raw, cleaned } = await readAndCleanNameOnce(bridgeRef.current, deck, zone);
        // Best-effort return to main so the user isn't stuck.
        if (back) {
          try {
            await bridgeRef.current.tapNext(deck, { point: back, pressDurationMs: settings.pressDurationMs });
            await sleep(settings.waitAfterBackMs);
          } catch { /* ignore */ }
        }
        setState((s) => ({ ...s, phase: "idle" }));
        if (cleaned) {
          const msg = `OCR brut : « ${raw} » · nettoyé : « ${cleaned} »`;
          log("success", `Test zone Nom platine ${deck} : ${msg}`);
          return { ok: true, raw, cleaned, message: msg };
        }
        const msg = "Zone lue mais aucun texte détecté — élargis le rectangle ou recalibre.";
        log("warning", `Test zone Nom platine ${deck} : ${msg}`);
        return { ok: false, raw, cleaned, message: msg };
      } catch (e) {
        const message = describe(e);
        log("error", `Test zone Nom platine ${deck} échoué : ${message}`);
        setState((s) => ({ ...s, phase: "error", errorMessage: message }));
        return { ok: false, raw: "", cleaned: "", message };
      }
    },
    [log],
  );

  return {
    state,
    start,
    stop,
    pause,
    resume,
    clearBackgroundState,
    getBackgroundStatus,
    resolvePending,
    skipPending,
    updateSettings,
    updateCalibrationElement,
    captureCalibration,
    supportsDirectCapture,
    testRead,
    testClick,
    testPlaylistButton,
    testBackButton,
    testNameZone,
    openAccessibilitySettings,
    checkAccessibility,
  } as const;
}

function emptyReading(): DiscDJReading {
  return { bpm: null, title: null, durationSec: null };
}

function resolveReadingMatch(
  reading: DiscDJReading,
  tracks: Track[],
  snapshot: AnalysisSnapshot | null,
): { track: Track | null; candidates: MatchCandidate[] } {
  if (!reading.title) return { track: null, candidates: [] };
  const normalized = normalizeTitle(reading.title);
  const aliasPath = lookupAlias(snapshot, normalized);
  if (aliasPath) {
    const aliased = tracks.find((t) => t.path === aliasPath);
    if (aliased && durationCompatible(reading, aliased)) return { track: aliased, candidates: [] };
  }

  const result = findMatches(
    { title: reading.title, durationSec: reading.durationSec },
    tracks,
  );
  if (result.confident && durationCompatible(reading, result.confident.track)) {
    return { track: result.confident.track, candidates: [] };
  }
  return { track: null, candidates: result.candidates };
}

function durationCompatible(reading: DiscDJReading, track: Track): boolean {
  if (track.durationSec == null) return true;
  if (reading.durationSec == null) return false;
  return Math.abs(reading.durationSec - track.durationSec) <= DURATION_TOLERANCE_SEC;
}

function waitForManualChoice(
  reading: DiscDJReading,
  candidates: MatchCandidate[],
  setState: (updater: (state: RobotState) => RobotState) => void,
  pendingResolverRef: { current: ((v: TrackId | null) => void) | null },
): Promise<TrackId | null> {
  setState((s) => ({ ...s, phase: "awaiting-user", pending: { reading, candidates } }));
  return new Promise((resolve) => {
    pendingResolverRef.current = resolve;
  });
}

/**
 * Vote-based BPM read. Fires up to `bpmMaxAttempts` OCR passes and returns
 * the value that reaches `bpmValidVoteCount` identical readings first.
 * Only BPMs in the plausible [40, 240] range participate in the vote.
 * When no value reaches the quorum, we accept the mode if it appears at
 * least twice (heuristic close-values pick), otherwise return null so the
 * caller can mark the track "à réanalyser".
 */
async function readBpmWithVote(
  bridge: DiscDJBridge,
  deck: DeckId,
  settings: DiscDJRobotSettings,
  log: (level: RobotLogLevel, message: string) => void,
  positionLabel: string,
  stillRunning: () => boolean,
): Promise<{ bpm: number | null; reading: DiscDJReading; attempts: number; voteCount: number }> {
  const votes = new Map<number, number>();
  const rawReadings: number[] = [];
  let lastReading: DiscDJReading = emptyReading();
  const max = Math.max(3, settings.bpmMaxAttempts);
  const quorum = Math.max(2, settings.bpmValidVoteCount);

  const registerVote = (v: number, weight: number) => {
    votes.set(v, (votes.get(v) ?? 0) + weight);
  };

  for (let attempt = 1; attempt <= max; attempt++) {
    if (!stillRunning()) break;
    try {
      lastReading = await readSmartDeck(bridge, deck, settings, {}, log);
    } catch (e) {
      log("warning", `[${positionLabel}] tentative BPM ${attempt}/${max} en erreur (${describe(e)}) — nouvelle tentative.`);
      await sleep(Math.max(250, settings.waitBeforeReadMs));
      continue;
    }
    if (lastReading.endOfPlaylist) {
      return { bpm: null, reading: lastReading, attempts: attempt, voteCount: 0 };
    }
    if (isPlausibleBpm(lastReading.bpm)) {
      const rounded = Math.round(lastReading.bpm);
      rawReadings.push(rounded);
      // Base weight = 1. Favor 3-digit BPMs (100..240) which is where the
      // "150 read as 50" bug happens — an OCR pass that drops the leading
      // digit shouldn't outweigh two passes that agree on the full number.
      const weight = rounded >= 100 ? 2 : 1;
      registerVote(rounded, weight);
      log(
        "info",
        `[${positionLabel}] BPM lecture ${attempt}/${max} → ${rounded} (poids ${weight} · quorum ${quorum}).`,
      );

      // Heuristic "lost leading digit": if we already saw a 3-digit reading
      // and this one is 2-digit with the SAME last two digits, treat it as
      // the same 3-digit value (e.g. 150 vs 50 → count as 150).
      if (rounded < 100) {
        for (const seen of rawReadings) {
          if (seen >= 100 && seen % 100 === rounded) {
            registerVote(seen, 1);
            log("info", `[${positionLabel}] hypothèse chiffre perdu : ${rounded} interprété comme ${seen}.`);
            break;
          }
        }
      }

      const cur = votes.get(rounded) ?? 0;
      if (cur >= quorum) {
        log("success", `[${positionLabel}] BPM validé par vote : ${rounded} (score ${cur}).`);
        return { bpm: rounded, reading: lastReading, attempts: attempt, voteCount: cur };
      }
    } else {
      log("info", `[${positionLabel}] BPM lecture ${attempt}/${max} illisible — nouvelle tentative avec prétraitement différent.`);
    }
    // Backoff: slightly longer each attempt to let DiscDJ stabilize.
    await sleep(Math.max(220, Math.round(settings.waitBeforeReadMs / 2)) + attempt * 80);
  }

  // No quorum — pick the value with the best weighted score, provided it
  // has at least 2 supporting points OR is the only plausible one.
  let bestVal: number | null = null;
  let bestScore = 0;
  const allValues: string[] = [];
  for (const [val, score] of votes.entries()) {
    allValues.push(`${val}×${score}`);
    if (score > bestScore || (score === bestScore && bestVal != null && val > bestVal)) {
      bestVal = val;
      bestScore = score;
    }
  }
  log("info", `[${positionLabel}] Fin du vote BPM. Candidats : {${allValues.join(", ") || "aucun"}}. Retenu : ${bestVal ?? "aucun"}.`);
  if (bestVal != null && bestScore >= 2) {
    return { bpm: bestVal, reading: lastReading, attempts: max, voteCount: bestScore };
  }
  return { bpm: null, reading: lastReading, attempts: max, voteCount: bestScore };
}


async function readSmartDeck(
  bridge: DiscDJBridge,
  deck: DeckId,
  settings: DiscDJRobotSettings,
  hint: { title?: string | null; durationSec?: number | null },
  log: (level: RobotLogLevel, message: string) => void,
): Promise<DiscDJReading> {
  const cal = getDeckCalibration(settings, deck);
  await sleep(settings.waitBeforeReadMs);
  const passes = Math.max(2, settings.maxAttempts);
  const readings: DiscDJReading[] = [];
  let emptyZoneCount = 0;
  for (let i = 0; i < passes; i++) {
    const r = await bridge.readBpm(deck, { ...hint, bpmZone: cal.bpmZone });
    readings.push(r);
    if (r.sourceOk === false) {
      log("error", r.parseReason ?? "Mauvaise source d'image capturée : ce n'est pas l'écran DiscDJ.");
      break;
    }
    if (r.orientationOk === false) {
      log("error", r.parseReason ?? "Orientation incorrecte : DiscDJ doit rester en paysage.");
      break;
    }
    const hasText = (r.zoneTexts && r.zoneTexts.length > 0) || Boolean(r.raw);
    if (!hasText) {
      emptyZoneCount++;
      log("warning", `Lecture ${i + 1}/${passes} : zone OCR vide — nouvelle tentative dans un instant.`);
    } else if (r.title) {
      log("info", `Lecture ${i + 1}/${passes} : ${r.title}`);
    }
    if (isPlausibleBpm(r.bpm)) break; // BPM lisible, on peut sortir tôt
    if (i < passes - 1) await sleep(Math.max(220, Math.round(settings.waitBeforeReadMs / 2)));
  }
  const merged = mergeReadings(readings);
  if (!isPlausibleBpm(merged.bpm) && !merged.parseReason) {
    if (emptyZoneCount === readings.length) {
      merged.parseReason = "Zone OCR vide : aucun texte détecté dans la zone calibrée après plusieurs tentatives. Recalibre la zone BPM plus large ou plus précise.";
    } else if (!merged.raw) {
      merged.parseReason = "Capture invalide : la zone a renvoyé du texte sur certaines tentatives et rien sur d'autres — l'écran DiscDJ semble encore instable.";
    } else {
      merged.parseReason = `Valeur BPM illisible : texte détecté \"${merged.raw}\" mais aucun nombre valide entre 40 et 240.`;
    }
  }
  return merged;
}

async function checkAnalysisPreflight(
  bridge: DiscDJBridge,
  deck: DeckId,
  settings: DiscDJRobotSettings,
  log: (level: RobotLogLevel, message: string) => void,
): Promise<{ ok: boolean; reason?: string }> {
  const cal = getDeckCalibration(settings, deck);
  if (!cal.next || !cal.bpmZone) return { ok: false, reason: `Calibration incomplète pour la platine ${deck}.` };
  const pointOk = isValidPoint(cal.next);
  const rectOk = isValidRect(cal.bpmZone);
  if (!pointOk || !rectOk) return { ok: false, reason: "Calibration incohérente : coordonnées invalides." };
  if (bridge.checkReady) {
    try {
      const ready = await bridge.checkReady();
      if (!ready.ok) return { ok: false, reason: ready.reason ?? "DiscDJ n'est pas stable ou pas au premier plan." };
      log("success", `Pré-vérification OK : DiscDJ au premier plan, paysage, interface stable${ready.displayWidth && ready.displayHeight ? ` (${ready.displayWidth}×${ready.displayHeight})` : ""}.`);
    } catch (e) {
      return { ok: false, reason: `Pré-vérification DiscDJ impossible : ${describe(e)}` };
    }
  }
  return { ok: true };
}

function isValidPoint(p: { x: number; y: number } | null): boolean {
  return Boolean(p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
}

function isValidRect(r: { x: number; y: number; width: number; height: number } | null): boolean {
  return Boolean(
    r &&
      Number.isFinite(r.x) &&
      Number.isFinite(r.y) &&
      Number.isFinite(r.width) &&
      Number.isFinite(r.height) &&
      r.x >= 0 &&
      r.y >= 0 &&
      r.width > 0 &&
      r.height > 0 &&
      r.x + r.width <= 1 &&
      r.y + r.height <= 1,
  );
}

function mergeReadings(readings: DiscDJReading[]): DiscDJReading {
  const usable = readings.filter(Boolean);
  if (usable.length === 0) return emptyReading();
  const withBpm = usable.find((r) => isPlausibleBpm(r.bpm)) ?? usable[0];
  const bestTitle = reconstructScrollingTitle(usable.map((r) => r.title?.trim() ?? ""));
  const bestDuration = usable.find((r) => r.durationSec != null)?.durationSec ?? null;
  const zoneTexts = Array.from(new Set(usable.flatMap((r) => r.zoneTexts ?? []).map((s) => s.trim()).filter(Boolean)));
  const parseReason = withBpm.parseReason ?? usable.find((r) => r.parseReason)?.parseReason ?? null;
  return {
    ...withBpm,
    title: bestTitle,
    durationSec: bestDuration,
    raw: withBpm.raw,
    zoneTexts,
    parseReason,
    endOfPlaylist: usable.some((r) => r.endOfPlaylist),
  };
}

function reconstructScrollingTitle(rawParts: string[]): string | null {
  const parts = Array.from(
    new Set(rawParts.map((p) => p.trim()).filter((p) => normalizeTitle(p).length > 0)),
  ).sort((a, b) => normalizeTitle(b).length - normalizeTitle(a).length);
  if (parts.length === 0) return null;
  let merged = parts[0];
  for (const part of parts.slice(1)) {
    const nMerged = normalizeTitle(merged);
    const nPart = normalizeTitle(part);
    if (nMerged.includes(nPart)) continue;
    if (nPart.includes(nMerged)) {
      merged = part;
      continue;
    }
    const joined = joinByOverlap(merged, part);
    if (normalizeTitle(joined).length > normalizeTitle(merged).length) merged = joined;
  }
  return merged;
}

function joinByOverlap(a: string, b: string): string {
  const max = Math.min(a.length, b.length);
  let best = 0;
  for (let len = 3; len <= max; len++) {
    if (a.slice(-len).toLowerCase() === b.slice(0, len).toLowerCase()) best = len;
  }
  if (best > 0) return `${a}${b.slice(best)}`;
  best = 0;
  for (let len = 3; len <= max; len++) {
    if (b.slice(-len).toLowerCase() === a.slice(0, len).toLowerCase()) best = len;
  }
  if (best > 0) return `${b}${a.slice(best)}`;
  return a.length >= b.length ? a : b;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Background-safe sleep. Delegates to the native plugin when available
 * (Android Handler.postDelayed — NOT throttled when MixOrder is
 * offscreen), falls back to setTimeout on web. Use this inside long-
 * running analysis loops so the robot keeps running while the user has
 * DiscDJ in the foreground.
 */
function bgSleep(bridge: DiscDJBridge, ms: number): Promise<void> {
  if (typeof bridge.nativeSleep === "function") return bridge.nativeSleep(ms);
  return sleep(ms);
}

/**
 * Ensure DiscDJ owns the foreground before the next action. If not, wait a
 * few seconds, then re-open. The robot never asks the user to switch back
 * manually — that would break the whole unattended promise.
 */
async function ensureDiscDJForeground(
  bridge: DiscDJBridge,
  log: (level: RobotLogLevel, message: string) => void,
): Promise<void> {
  try {
    const status = (await bridge.isReady()) as { ready: boolean; foreground?: boolean };
    if (status.foreground !== false) return;
  } catch { /* fall through to reopen */ }
  log("warning", "DiscDJ n'est plus au premier plan — réouverture automatique.");
  await bgSleep(bridge, 1500);
  try { await bridge.openApp(); } catch { /* ignore — next OCR will retry */ }
  await bgSleep(bridge, 1200);
}

/**
 * Single OCR pass on the calibrated BPM zone. Returns the BPM if the
 * reading is plausible (40..240), otherwise `null`. No votes, no quorums.
 */
async function readBpmOnce(
  bridge: DiscDJBridge,
  deck: DeckId,
  bpmZone: CalibrationRect,
  settings: DiscDJRobotSettings,
): Promise<number | null> {
  await bgSleep(bridge, Math.max(200, settings.waitBeforeReadMs));
  try {
    const r = await bridge.readBpm(deck, { bpmZone });
    if (isPlausibleBpm(r.bpm)) return Math.round(r.bpm);
  } catch { /* handled by caller retry */ }
  return null;
}

/**
 * Tap the Back button and wait for the main screen to settle. Best-effort
 * — a failed tap is recoverable because `ensureDiscDJForeground` is called
 * before the next action anyway.
 */
async function returnToMain(
  bridge: DiscDJBridge,
  deck: DeckId,
  backBtn: CalibrationPoint,
  settings: DiscDJRobotSettings,
): Promise<void> {
  try {
    await bridge.tapNext(deck, { point: backBtn, pressDurationMs: settings.pressDurationMs });
  } catch { /* ignore, we'll re-check foreground next step */ }
  await bgSleep(bridge, settings.waitAfterBackMs);
}

async function returnToMainStrict(
  bridge: DiscDJBridge,
  deck: DeckId,
  backBtn: CalibrationPoint,
  settings: DiscDJRobotSettings,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await bridge.tapNext(deck, { point: backBtn, pressDurationMs: settings.pressDurationMs });
      await bgSleep(bridge, settings.waitAfterBackMs);
      return true;
    } catch {
      await bgSleep(bridge, 350);
    }
  }
  await bgSleep(bridge, settings.waitAfterBackMs);
  return false;
}

function resolveAutoSyncNameMatch(
  ocrCandidates: string[],
  library: Track[],
  expected: Track,
  threshold: number,
): { track: Track | null; score: number; best: { track: Track; score: number } | null } {
  const candidates = Array.from(new Set(ocrCandidates.map((c) => c.trim()).filter(Boolean)));
  let bestGlobal: { track: Track; score: number; confident: boolean } | null = null;

  for (const candidate of candidates) {
    const m = findBestMatch<Track>(candidate, library, trackNameVariants, { threshold, ambiguityGap: 0.04 });
    if (m.best && (!bestGlobal || m.best.score > bestGlobal.score)) {
      bestGlobal = { track: m.best.item, score: m.best.score, confident: m.confident };
    }
  }

  const expectedScore = Math.max(
    0,
    ...candidates.flatMap((candidate) => trackNameVariants(expected).map((name) => similarity(candidate, name))),
  );

  if (
    expectedScore >= Math.min(0.5, threshold) ||
    (expectedScore >= 0.38 && (!bestGlobal || bestGlobal.track.id === expected.id || bestGlobal.score - expectedScore <= 0.16))
  ) {
    return { track: expected, score: expectedScore, best: bestGlobal ? { track: bestGlobal.track, score: bestGlobal.score } : null };
  }

  if (bestGlobal?.confident) {
    return { track: bestGlobal.track, score: bestGlobal.score, best: { track: bestGlobal.track, score: bestGlobal.score } };
  }

  return { track: null, score: 0, best: bestGlobal ? { track: bestGlobal.track, score: bestGlobal.score } : null };
}

function trackNameVariants(track: Track): string[] {
  const pathName = track.path.split(/[\\/]/).pop() ?? track.path;
  return Array.from(new Set([track.name, track.originalName, pathName, pathName.replace(/\.[^.]+$/, "")].filter(Boolean)));
}

/**
 * Deterministic OCR rect for the first (selected/blue) row of the DiscDJ
 * playlist. DiscDJ splits the playlist screen in half — deck 1 on the left,
 * deck 2 on the right — with the currently-loaded track pinned to the top
 * of each column just below the toolbar. No user calibration is required.
 *
 * All values are in the canonical landscape frame (fractions of the
 * display). Tuned to be wide/high enough for OCR to catch the full title
 * text (which DiscDJ writes vertically along the row).
 */
function firstRowZoneFor(deck: DeckId): CalibrationRect {
  const width = 0.42;
  const x = deck === 1 ? 0.04 : 0.54;
  return { x, y: 0.06, width, height: 0.12 };
}


function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return String(e);
  } catch {
    return "erreur inconnue";
  }
}

/**
 * AutoSync — read the currently selected playlist row via OCR, then fuzzy-
 * match against the MixOrder library. Retries up to `maxRetries` when the
 * match confidence is below `threshold`. Returns the best-scoring attempt.
 *
 * OCR is delegated to `bridge.readBpm` with the playlist-row rect passed as
 * `bpmZone` — the native plugin returns `raw`/`zoneTexts` regardless of
 * whether a BPM number was parsed, which is exactly the text we need.
 */
async function readNameWithRetries(
  bridge: DiscDJBridge,
  deck: DeckId,
  rowZone: import("./discdj-settings").CalibrationRect,
  maxRetries: number,
  library: Track[],
  threshold: number,
  log: (level: RobotLogLevel, message: string) => void,
  positionLabel: string,
  stillRunning: () => boolean,
): Promise<{
  ocrName: string;
  match: ReturnType<typeof findBestMatch<Track>>;
}> {
  let bestOcr = "";
  let bestMatch = findBestMatch<Track>("", library, (t) => t.name, { threshold });
  const attempts = Math.max(1, maxRetries);
  for (let i = 1; i <= attempts; i++) {
    if (!stillRunning()) break;
    const { cleaned } = await readAndCleanNameOnce(bridge, deck, rowZone);
    if (cleaned) {
      const m = findBestMatch<Track>(cleaned, library, (t) => t.name, { threshold });
      log(
        "info",
        `[${positionLabel}] OCR nom ${i}/${attempts}: "${cleaned}" → ${m.best ? `${m.best.item.name} (${(m.best.score * 100).toFixed(0)}%)` : "aucun candidat"}`,
      );
      if (!bestMatch.best || (m.best?.score ?? 0) > (bestMatch.best?.score ?? 0)) {
        bestMatch = m;
        bestOcr = cleaned;
      }
      if (m.confident) break;
    } else {
      log("warning", `[${positionLabel}] OCR nom ${i}/${attempts}: aucun texte lisible dans la zone calibrée.`);
    }
    if (i < attempts) await sleep(350);
  }
  return { ocrName: bestOcr, match: bestMatch };
}

/**
 * One OCR pass on the calibrated name zone. Returns both the raw text and a
 * cleaned version (control chars stripped, whitespace normalized, obvious
 * OCR parasites removed). The library-side normalization is separate and
 * lives in name-normalize.ts.
 */
export async function readAndCleanNameOnce(
  bridge: DiscDJBridge,
  deck: DeckId,
  rowZone: import("./discdj-settings").CalibrationRect,
): Promise<{ raw: string; cleaned: string; zoneTexts: string[]; candidates: string[] }> {
  let raw = "";
  let zoneTexts: string[] = [];
  try {
    const r = await bridge.readBpm(deck, { bpmZone: rowZone });
    zoneTexts = (r.zoneTexts ?? []).map((s) => s.trim()).filter(Boolean);
    // Prefer joining multi-line OCR output (title + separator) so we don't
    // lose the second half of a wrapped name; fall back to raw.
    raw = zoneTexts.length > 0 ? zoneTexts.join(" ") : (r.raw ?? "");
  } catch { /* swallow — caller retries */ }
  const candidates = buildOcrNameCandidates(raw, zoneTexts);
  return { raw, cleaned: candidates[0] ?? "", zoneTexts, candidates };
}

function buildOcrNameCandidates(raw: string, zoneTexts: string[]): string[] {
  const chunks = [
    raw,
    ...zoneTexts,
    zoneTexts.join(" "),
    zoneTexts.slice(0, 2).join(" "),
    zoneTexts.slice(-2).join(" "),
  ];
  const cleaned = chunks.map(cleanOcrText).filter(Boolean);
  return Array.from(new Set(cleaned)).sort((a, b) => normalizeTrackName(b).length - normalizeTrackName(a).length);
}

/**
 * Light-touch cleanup of the OCR string BEFORE library matching:
 *  - strip control chars
 *  - collapse repeated whitespace / underscores / dashes
 *  - drop leading numeric prefixes (e.g. "035_", "03 - ")
 *  - drop trailing file extensions
 *  - remove obviously-parasitic single characters
 * Case is preserved so the UI can display it verbatim; normalization to a
 * comparable form is done by name-normalize.ts.
 */
export function cleanOcrText(input: string): string {
  if (!input) return "";
  // 1. Split into candidate lines (OCR often returns one per row).
  const rawLines = input
    .replace(/[\u0000-\u001f\u007f]+/g, "\n")
    .replace(/[·•●▪■□]/g, " ")
    .split(/[\r\n]+/);

  // 2. Drop every line that isn't a track title — DiscDJ UI labels, status
  //    markers, playlist headers, unknown-track placeholders, etc.
  const kept = rawLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !isDiscDJParasite(l));

  if (kept.length === 0) return "";

  // 3. Prefer the longest remaining line — the title is almost always the
  //    line with the most alphabetic characters.
  const chosen = kept
    .slice()
    .sort((a, b) => letterCount(b) - letterCount(a))[0];

  // 4. Final scrub: strip file extensions, leading numeric prefixes,
  //    embedded BPM mentions, emojis, repeated separators, edge punctuation.
  let s = chosen;
  s = s.replace(/\.(mp3|wav|flac|m4a|aac|ogg|wma|aiff)\b/gi, "");
  s = s.replace(/\bbpm\s*[:=]?\s*\d{2,3}(?:[.,]\d+)?\b/gi, " ");
  s = s.replace(/^\s*\d{1,4}\s*[_\-–—.:]+\s*/, "");
  s = s.replace(/[\p{Extended_Pictographic}]/gu, " ");
  s = s.replace(/[_]{2,}/g, "_").replace(/[-]{2,}/g, "-");
  s = s.replace(/^[\s\W_]+|[\s\W_]+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Count alphabetic characters — length alone would rank "-----" too high. */
function letterCount(s: string): number {
  const m = s.match(/\p{L}/gu);
  return m ? m.length : 0;
}

/**
 * DiscDJ overlays a lot of non-title text on the playlist row (technical
 * labels, section names, `<unknown>` placeholders). Any line matching one
 * of these patterns is dropped before matching, so the comparator only ever
 * sees plausible title text.
 */
const DISCDJ_PARASITE_TOKENS = [
  "unknown",
  "pitch bend",
  "pitchbend",
  "keylock",
  "key lock",
  "reloop",
  "loop in",
  "loop out",
  "loop",
  "cue",
  "sync",
  "sampler",
  "tempo",
  "master",
  "treble",
  "mid",
  "bass",
  "eq",
  "gain",
  "volume",
  "browse",
  "playlist",
  "playlists",
  "history",
  "search",
  "all purpose",
  "recording",
  "record",
  "auto mix",
  "automix",
  "quantize",
  "beatgrid",
  "beat grid",
  "hot cue",
  "flanger",
  "echo",
  "reverb",
  "filter",
  "fx",
];

function isDiscDJParasite(line: string): boolean {
  const low = line.toLowerCase().trim();
  if (!low) return true;
  if (low === "in" || low === "out" || low === "on" || low === "off") return true;
  // Placeholders like "<unknown>" or "< unknown >".
  if (/^<\s*\w+\s*>$/.test(low)) return true;
  // Lines that are ONLY digits / punctuation (BPM readouts, timers).
  if (letterCount(low) < 2) return true;
  // Very short label-like tokens.
  if (low.length <= 3 && !/\s/.test(low)) return true;
  return DISCDJ_PARASITE_TOKENS.some((tok) => low === tok || low.startsWith(tok + " ") || low.endsWith(" " + tok));
}

