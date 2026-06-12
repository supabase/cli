import { describe, expect, it } from "vitest";

import {
  legacyBillingUrl,
  legacyDashboardUrl,
  legacyPoolerHost,
  legacyProjectHost,
} from "./legacy-profile.ts";

describe("legacyProjectHost", () => {
  it("maps built-in profile names to the Go project_host", () => {
    expect(legacyProjectHost("supabase")).toBe("supabase.co");
    expect(legacyProjectHost("supabase-staging")).toBe("supabase.red");
    expect(legacyProjectHost("supabase-local")).toBe("supabase.red");
    expect(legacyProjectHost("snap")).toBe("snapcloud.dev");
  });

  it("falls back to supabase.co for unknown / YAML-mode profiles", () => {
    expect(legacyProjectHost("custom-profile")).toBe("supabase.co");
  });
});

describe("legacyPoolerHost", () => {
  it("maps built-in profile names to the Go pooler_host", () => {
    expect(legacyPoolerHost("supabase")).toBe("supabase.com");
    expect(legacyPoolerHost("supabase-staging")).toBe("supabase.green");
    expect(legacyPoolerHost("snap")).toBe("snapcloud.co");
  });

  it("returns an empty pooler_host for supabase-local (no domain assertion)", () => {
    expect(legacyPoolerHost("supabase-local")).toBe("");
  });

  it("falls back to supabase.com for unknown / YAML-mode profiles", () => {
    expect(legacyPoolerHost("custom-profile")).toBe("supabase.com");
  });
});

describe("legacyDashboardUrl", () => {
  it("maps built-in profile names to the Go dashboard_url", () => {
    expect(legacyDashboardUrl("supabase")).toBe("https://supabase.com/dashboard");
    expect(legacyDashboardUrl("supabase-staging")).toBe("https://supabase.green/dashboard");
    expect(legacyDashboardUrl("supabase-local")).toBe("http://localhost:8082");
  });

  it("falls back to the production dashboard for unknown profiles", () => {
    expect(legacyDashboardUrl("custom-profile")).toBe("https://supabase.com/dashboard");
  });
});

describe("legacyBillingUrl", () => {
  it("composes the dashboard URL with /org/<slug>/billing", () => {
    expect(legacyBillingUrl("supabase", "acme")).toBe(
      "https://supabase.com/dashboard/org/acme/billing",
    );
    expect(legacyBillingUrl("supabase-staging", "acme")).toBe(
      "https://supabase.green/dashboard/org/acme/billing",
    );
  });
});
