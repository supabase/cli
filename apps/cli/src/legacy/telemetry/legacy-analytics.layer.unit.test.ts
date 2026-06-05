import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EnvSignalPresenceKeys,
  EnvSignalValueKeys,
  MaxEnvSignalValueLength,
} from "../../shared/telemetry/event-catalog.ts";
import { collectEnvSignals } from "./legacy-analytics.layer.ts";

const RESET_KEYS = [...EnvSignalPresenceKeys, ...EnvSignalValueKeys];

function snapshotEnv() {
  const original: Record<string, string | undefined> = {};
  for (const key of RESET_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  return original;
}

function restoreEnv(original: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("collectEnvSignals", () => {
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    original = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(original);
  });

  it("returns undefined when no relevant env vars are set", () => {
    expect(collectEnvSignals()).toBeUndefined();
  });

  it("records presence keys as boolean `true`", () => {
    process.env.CI = "1";
    process.env.CLAUDECODE = "true";

    const signals = collectEnvSignals();
    expect(signals).toEqual({
      CI: true,
      CLAUDECODE: true,
    });
  });

  it("records value keys as trimmed strings", () => {
    process.env.AI_AGENT = "  claude-code  ";
    process.env.TERM = "xterm-256color";

    const signals = collectEnvSignals();
    expect(signals).toEqual({
      AI_AGENT: "claude-code",
      TERM: "xterm-256color",
    });
  });

  it("caps value-key strings at MaxEnvSignalValueLength chars", () => {
    const long = "a".repeat(MaxEnvSignalValueLength + 50);
    process.env.AI_AGENT = long;

    const signals = collectEnvSignals();
    const aiAgent = signals?.AI_AGENT;
    expect(aiAgent).toBe("a".repeat(MaxEnvSignalValueLength));
    expect(typeof aiAgent === "string" ? aiAgent.length : -1).toBe(MaxEnvSignalValueLength);
  });

  it("skips presence keys with empty/whitespace-only values", () => {
    process.env.CI = "";
    process.env.GITHUB_ACTIONS = "   ";

    expect(collectEnvSignals()).toBeUndefined();
  });

  it("skips value keys with empty/whitespace-only values", () => {
    process.env.AI_AGENT = "   ";

    expect(collectEnvSignals()).toBeUndefined();
  });
});
