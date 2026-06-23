import { Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EnvSignalPresenceKeys,
  EnvSignalValueKeys,
  GroupOrganization,
  GroupProject,
  MaxEnvSignalValueLength,
} from "../../shared/telemetry/event-catalog.ts";
import { collectEnvSignals, resolveGroups } from "./legacy-analytics.layer.ts";

const linkedCacheValue = (over: Partial<Record<string, string>> = {}) => ({
  ref: "proj-ref",
  name: "Proj",
  organization_id: "org-id-123",
  organization_slug: "acme",
  ...over,
});

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

describe("resolveGroups", () => {
  it("returns undefined when there is no linked project and no context groups", () => {
    expect(resolveGroups({}, Option.none())).toBeUndefined();
  });

  it("keys the organization group by organization_id (not slug) to match Go", () => {
    const groups = resolveGroups({}, Option.some(linkedCacheValue()));
    // Must be the org ID so the event group matches what groupIdentify published
    // (apps/cli-go/internal/telemetry/project.go:99-103). The slug is never a key.
    expect(groups).toEqual({
      [GroupOrganization]: "org-id-123",
      [GroupProject]: "proj-ref",
    });
    expect(groups?.[GroupOrganization]).not.toBe("acme");
  });

  it("omits the organization group when the linked org ID is empty", () => {
    const groups = resolveGroups({}, Option.some(linkedCacheValue({ organization_id: "" })));
    expect(groups).toEqual({ [GroupProject]: "proj-ref" });
    expect(GroupOrganization in (groups ?? {})).toBe(false);
  });

  it("prefers context groups (already org-id keyed) over the linked cache", () => {
    const groups = resolveGroups(
      { groups: { organization: "ctx-org-id", project: "ctx-ref" } },
      Option.some(linkedCacheValue()),
    );
    expect(groups).toEqual({
      [GroupOrganization]: "ctx-org-id",
      [GroupProject]: "ctx-ref",
    });
  });
});
