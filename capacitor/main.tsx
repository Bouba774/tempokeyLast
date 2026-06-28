/**
 * Capacitor SPA entry — runs in the Android WebView.
 * Independent from the TanStack Start SSR pipeline used on web.
 *
 * - Uses TanStack Router in pure client mode with hash history
 *   (file:// URLs in WebViews don't tolerate history API navigation).
 * - Wraps the app in a global ErrorBoundary so no React crash ever
 *   results in a black screen.
 * - Emits diagnostic logs at each boot stage so adb logcat can pinpoint
 *   where startup blocks.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  RouterProvider,
  createRouter,
  createHashHistory,
} from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "../src/routeTree.gen";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { initAndroidBack } from "../src/lib/android-back";
import "../src/styles.css";

const log = (stage: string, extra?: unknown) => {
  // Visible in `adb logcat | grep Capacitor/Console`
  // eslint-disable-next-line no-console
  console.log(`[TempoKey] ${stage}`, extra ?? "");
};

log("App Started");

// Mark the native Android WebView early. The global CSS uses this class to
// disable effects known to deadlock or severely stall Android System WebView
// during taps/focus (fixed + backdrop-filter + entrance transforms).
if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("native-android");
}

// Single centralized Android hardware back-button handler (native leave on
// root, Escape dispatch for modals/menus, history.back for inner screens,
// keyboard dismiss). Stack of component handlers is registered via the
// useBackHandler hook.
void initAndroidBack();

// Optional Capacitor diagnostics + edge-to-edge wiring.
// All imports stay dynamic so the SPA bundle compiles even if a package is
// absent during web preview ; failures are swallowed.
(async () => {
  try {
    const cap = await import("@capacitor/core").catch(() => null);
    if (cap?.Capacitor) {
      log("Capacitor Detected", {
        native: cap.Capacitor.isNativePlatform(),
        platform: cap.Capacitor.getPlatform(),
      });
    }

    // ── Edge-to-edge status & navigation bar sync with the active theme ──
    // The WebView is already overlaying the system bars (capacitor.config.ts).
    // We just need to push the icon style (light/dark) when the theme flips.
    const sb = await import("@capacitor/status-bar").catch(() => null);
    if (sb?.StatusBar && cap?.Capacitor?.isNativePlatform()) {
      // Capacitor StatusBar.Style mapping (per @capacitor/status-bar v6 docs):
      //   Style.Dark  = DARK status bar background → LIGHT (white) icons
      //                 → use on DARK app themes
      //   Style.Light = LIGHT status bar background → DARK (black) icons
      //                 → use on LIGHT app themes
      //   Style.Default = follow system
      const apply = () => {
        const isDark = document.documentElement.classList.contains("dark");

        // Keep WebView overlaying system bars (true edge-to-edge fullscreen).
        sb.StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});

        // Push the correct icon contrast for the active theme.
        // Dark theme → Style.Dark (white icons on our dark bg)
        // Light theme → Style.Light (black icons on our light bg)
        sb.StatusBar.setStyle({
          style: isDark ? sb.Style.Dark : sb.Style.Light,
        }).catch(() => {});

        // Fully transparent — the app background paints under the status bar.
        sb.StatusBar.setBackgroundColor({ color: "#00000000" }).catch(() => {});

        // Make sure we're never in legacy "hide" mode (would clip the layout).
        sb.StatusBar.show().catch(() => {});

        // Mirror the active background into <meta name="theme-color"> so the
        // recents thumbnail picks up the right tint when the WebView is
        // briefly opaque (Android 12+).
        const hex = isDark ? "#0A0D14" : "#FFFFFF";
        let meta = document.querySelector<HTMLMetaElement>(
          'meta[name="theme-color"]',
        );
        if (!meta) {
          meta = document.createElement("meta");
          meta.name = "theme-color";
          document.head.appendChild(meta);
        }
        meta.content = hex;
      };
      apply();
      // Re-sync on theme toggle (classList mutations on <html>)
      const obs = new MutationObserver(apply);
      obs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      // Re-sync when app comes back from background
      const appMod = await import("@capacitor/app").catch(() => null);
      appMod?.App?.addListener?.("appStateChange", ({ isActive }) => {
        if (isActive) apply();
      }).catch(() => {});
    }
  } catch (e) {
    log("Capacitor Probe Skipped", String(e));
  }
})();


function boot() {
  try {
    log("Storage Init");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, staleTime: 60_000 } },
    });

    log("Router Init");
    const router = createRouter({
      routeTree,
      history: createHashHistory(),
      context: { queryClient },
      defaultPreloadStaleTime: 0,
      defaultErrorComponent: ({ error, reset }) => {
        // eslint-disable-next-line no-console
        console.error("[TempoKey] Route error", error);
        return (
          <div style={{ padding: 24, color: "#e6e8ee", background: "#0A0D14", minHeight: "100dvh" }}>
            <h1 style={{ fontSize: 18, marginBottom: 8 }}>Une erreur est survenue</h1>
            <p style={{ fontSize: 13, color: "#8a90a2", marginBottom: 16 }}>
              {error?.message || "Erreur inconnue"}
            </p>
            <button
              onClick={() => reset()}
              style={{
                background: "#7c5cff", color: "white", border: 0,
                padding: "10px 16px", borderRadius: 10, fontWeight: 600,
              }}
            >
              Réessayer
            </button>
          </div>
        );
      },
      defaultNotFoundComponent: () => (
        <div style={{ padding: 24, color: "#e6e8ee", background: "#0A0D14", minHeight: "100dvh" }}>
          <h1>Page introuvable</h1>
          <a href="#/" style={{ color: "#7c5cff" }}>Retour à l'accueil</a>
        </div>
      ),
    });

    log("UI Mounting");
    const container = document.getElementById("app");
    if (!container) throw new Error("Missing #app root element");
    const root = createRoot(container);
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <RouterProvider router={router} />
        </ErrorBoundary>
      </StrictMode>,
    );
    log("App Ready");

    // Hide native splash once React rendered (no-op on web)
    void import("@capacitor/splash-screen")
      .then((m) => m.SplashScreen?.hide?.())
      .catch(() => {});
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[TempoKey] Boot failure", err);
    document.body.innerHTML = `
      <div style="padding:24px;color:#e6e8ee;background:#0A0D14;min-height:100dvh;font-family:system-ui">
        <h1 style="font-size:18px;margin:0 0 8px">TempoKey n'a pas pu démarrer</h1>
        <p style="font-size:13px;color:#8a90a2;margin:0 0 16px">${(err as Error)?.message ?? err}</p>
        <button onclick="location.reload()" style="background:#7c5cff;color:#fff;border:0;padding:10px 16px;border-radius:10px;font-weight:600">Redémarrer</button>
      </div>`;
  }
}

// Global safety nets
window.addEventListener("error", (e) => {
  // eslint-disable-next-line no-console
  console.error("[TempoKey] window.error", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  // eslint-disable-next-line no-console
  console.error("[TempoKey] unhandledrejection", e.reason);
});

boot();
