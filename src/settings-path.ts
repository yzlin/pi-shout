import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const SETTINGS_FILENAME = "pi-shout.json";

export function settingsPath(): string {
  return join(getAgentDir(), SETTINGS_FILENAME);
}

export const LOG_FILENAME = "pi-voice.log";

export function logPath(): string {
  return join(getAgentDir(), LOG_FILENAME);
}
