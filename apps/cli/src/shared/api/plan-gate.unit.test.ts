import { describe, expect, it } from "vitest";

import {
  errorEntitlement,
  orgSlugFromUpgradeUrl,
  parsePlanGateEnvelope,
  parsePlanGateEnvelopeText,
  planGateSuggestion,
} from "./plan-gate.ts";

const ENVELOPE = {
  message: "Custom domains require the Pro plan",
  error: {
    code: "entitlement_required",
    feature: "custom_domain",
    upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
  },
};

describe("parsePlanGateEnvelope", () => {
  it("parses a full envelope into the wire shape", () => {
    expect(parsePlanGateEnvelope(ENVELOPE)).toEqual({
      feature: "custom_domain",
      upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
    });
  });

  it("rejects a non-entitlement code", () => {
    const body = { error: { ...ENVELOPE.error, code: "other" } };
    expect(parsePlanGateEnvelope(body)).toBeUndefined();
  });

  it("rejects a missing feature", () => {
    const body = { error: { code: "entitlement_required", upgrade_url: "https://x" } };
    expect(parsePlanGateEnvelope(body)).toBeUndefined();
  });

  it("rejects a missing upgrade_url", () => {
    const body = { error: { code: "entitlement_required", feature: "custom_domain" } };
    expect(parsePlanGateEnvelope(body)).toBeUndefined();
  });

  it("rejects non-object bodies", () => {
    expect(parsePlanGateEnvelope("nope")).toBeUndefined();
    expect(parsePlanGateEnvelope(null)).toBeUndefined();
    expect(parsePlanGateEnvelope([])).toBeUndefined();
  });

  it("rejects fields containing control characters", () => {
    const ansi = {
      error: { ...ENVELOPE.error, upgrade_url: "https://x/org/o/billing[2J[H" },
    };
    const newline = { error: { ...ENVELOPE.error, feature: "custom\ndomain" } };
    expect(parsePlanGateEnvelope(ansi)).toBeUndefined();
    expect(parsePlanGateEnvelope(newline)).toBeUndefined();
  });

  it("rejects oversized fields", () => {
    const body = { error: { ...ENVELOPE.error, upgrade_url: `https://x/${"a".repeat(2048)}` } };
    expect(parsePlanGateEnvelope(body)).toBeUndefined();
  });
});

describe("parsePlanGateEnvelopeText", () => {
  it("parses raw JSON text", () => {
    expect(parsePlanGateEnvelopeText(JSON.stringify(ENVELOPE))).toEqual({
      feature: "custom_domain",
      upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
    });
  });

  it("returns undefined for invalid JSON", () => {
    expect(parsePlanGateEnvelopeText("{truncated")).toBeUndefined();
    expect(parsePlanGateEnvelopeText("")).toBeUndefined();
  });
});

describe("orgSlugFromUpgradeUrl", () => {
  it("extracts the org slug", () => {
    expect(orgSlugFromUpgradeUrl("https://supabase.com/dashboard/org/env-org/billing")).toBe(
      "env-org",
    );
  });

  it("returns empty string when no org segment exists", () => {
    expect(orgSlugFromUpgradeUrl("https://supabase.com/dashboard/billing")).toBe("");
  });

  it("stops at query and fragment delimiters", () => {
    expect(orgSlugFromUpgradeUrl("https://supabase.com/dashboard/org/env-org?tab=billing")).toBe(
      "env-org",
    );
    expect(orgSlugFromUpgradeUrl("https://supabase.com/dashboard/org/env-org#billing")).toBe(
      "env-org",
    );
  });
});

describe("errorEntitlement", () => {
  it("reads a valid entitlement off an error-shaped object", () => {
    const error = {
      _tag: "SomeError",
      entitlement: { feature: "custom_domain", upgrade_url: "https://x/org/o/billing" },
    };
    expect(errorEntitlement(error)).toEqual({
      feature: "custom_domain",
      upgrade_url: "https://x/org/o/billing",
    });
  });

  it("rejects malformed entitlement values", () => {
    expect(errorEntitlement({ entitlement: { feature: "x" } })).toBeUndefined();
    expect(errorEntitlement({ entitlement: "custom_domain" })).toBeUndefined();
    expect(errorEntitlement({})).toBeUndefined();
    expect(errorEntitlement(undefined)).toBeUndefined();
    expect(
      errorEntitlement({
        entitlement: { feature: "x", upgrade_url: "https://x/org/o[2J" },
      }),
    ).toBeUndefined();
  });
});

describe("planGateSuggestion", () => {
  it("wraps the rendered url in the fixed prose", () => {
    expect(planGateSuggestion("URL")).toBe(
      "Your organization does not have access to this feature. Upgrade your plan: URL",
    );
  });
});
