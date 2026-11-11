import { type ColorStream, error, muted, success, warning } from "../command-internal/colors.ts";

type Tone = "good" | "busy" | "bad" | "off";

/** API status codes as people read them, with the tone their dot takes. */
const KNOWN: Readonly<Record<string, readonly [label: string, tone: Tone]>> = {
  ACTIVE_HEALTHY: ["Healthy", "good"],
  ACTIVE_UNHEALTHY: ["Unhealthy", "bad"],
  UNHEALTHY: ["Unhealthy", "bad"],
  COMING_UP: ["Starting", "busy"],
  GOING_DOWN: ["Stopping", "busy"],
  INACTIVE: ["Paused", "off"],
  PAUSING: ["Pausing", "busy"],
  INIT_FAILED: ["Failed", "bad"],
  RESTORE_FAILED: ["Restore failed", "bad"],
  PAUSE_FAILED: ["Pause failed", "bad"],
  REMOVED: ["Removed", "off"],
  RESTORING: ["Restoring", "busy"],
  UPGRADING: ["Upgrading", "busy"],
  RESTARTING: ["Restarting", "busy"],
  RESIZING: ["Resizing", "busy"],
  PROMOTING: ["Promoting", "busy"],
  UNKNOWN: ["Unknown", "off"],
  INIT_READ_REPLICA: ["Starting", "busy"],
  INIT_READ_REPLICA_FAILED: ["Failed", "bad"],
  CREATING_PROJECT: ["Creating", "busy"],
  RUNNING_MIGRATIONS: ["Migrating", "busy"],
  MIGRATIONS_PASSED: ["Ready", "good"],
  MIGRATIONS_FAILED: ["Migrations failed", "bad"],
  FUNCTIONS_DEPLOYED: ["Ready", "good"],
  FUNCTIONS_FAILED: ["Functions failed", "bad"],
};

const guessTone = (code: string): Tone =>
  /FAIL|ERROR|DEAD|UNHEALTHY|EXPIRED/.test(code)
    ? "bad"
    : /HEALTHY|ACTIVE|READY|PASSED|DEPLOYED|RUNNING|AVAILABLE|COMPLETED|APPLIED|IN_USE/.test(code)
      ? "good"
      : /ING$|PENDING|INITIATED/.test(code)
        ? "busy"
        : "off";

const sentenceCase = (code: string): string => {
  const words = code.toLowerCase().replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Renders an API status as `● Label` with the dot in its tone's colour; quiet states are dim. */
export function formatStatus(raw: string, stream: ColorStream = process.stdout): string {
  const code = raw.trim().toUpperCase();
  if (code === "") return "";
  const [label, tone] = KNOWN[code] ?? [sentenceCase(code), guessTone(code)];
  switch (tone) {
    case "good":
      return `${success("●", stream)} ${label}`;
    case "busy":
      return `${warning("●", stream)} ${label}`;
    case "bad":
      return `${error("●", stream)} ${label}`;
    case "off":
      return muted(`● ${label}`, stream);
  }
}
