import { registerPlugin } from "@capacitor/core";

/**
 * Native Capacitor plugin that drives the DiscDJ Android app through an
 * AccessibilityService. Web fallback throws — the DiscDJ bridge picks the
 * simulated implementation when this plugin is unavailable.
 *
 * @typedef {1 | 2} DeckId
 * @typedef {{ ready: boolean, reason?: string, discdjInstalled: boolean, accessibilityEnabled: boolean }} DiscDJReadyStatus
 * @typedef {{ bpm: number|null, raw: string|null, title: string|null, duration: string|null, endOfPlaylist?: boolean }} DiscDJBpmReading
 */

const DiscDJRobot = registerPlugin("DiscDJRobot");

export { DiscDJRobot };
export default DiscDJRobot;
