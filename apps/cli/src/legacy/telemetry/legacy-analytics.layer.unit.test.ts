import { Option } from "effect";
import { describe, expect, it } from "vitest";
import {
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

describe("collectEnvSignals", () => {
  it("returns undefined when no relevant env vars are set", () => {
    expect(collectEnvSignals({})).toBeUndefined();
  });

  it("records presence keys as boolean `true`", () => {
    const signals = collectEnvSignals({ CI: "1", CLAUDECODE: "true" });
    expect(signals).toEqual({
      CI: true,
      CLAUDECODE: true,
    });
  });

  it("records value keys as trimmed strings", () => {
    const signals = collectEnvSignals({ AI_AGENT: "  claude-code  ", TERM: "xterm-256color" });
    expect(signals).toEqual({
      AI_AGENT: "claude-code",
      TERM: "xterm-256color",
    });
  });

  it("caps value-key strings at MaxEnvSignalValueLength chars", () => {
    const long = "a".repeat(MaxEnvSignalValueLength + 50);
    const signals = collectEnvSignals({ AI_AGENT: long });
    const aiAgent = signals?.AI_AGENT;
    expect(aiAgent).toBe("a".repeat(MaxEnvSignalValueLength));
    expect(typeof aiAgent === "string" ? aiAgent.length : -1).toBe(MaxEnvSignalValueLength);
  });

  it("skips presence keys with empty/whitespace-only values", () => {
    expect(collectEnvSignals({ CI: "", GITHUB_ACTIONS: "   " })).toBeUndefined();
  });

  it("skips value keys with empty/whitespace-only values", () => {
    expect(collectEnvSignals({ AI_AGENT: "   " })).toBeUndefined();
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
