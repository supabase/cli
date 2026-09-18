import { describe, expect, it } from "vitest";

import { billingUrl, dashboardUrl, poolerHost, projectHost } from "./profile.ts";

describe("projectHost", () => {
  it("maps built-in profile names to the Go project_host", () => {
    expect(projectHost("supabase")).toBe("supabase.co");
    expect(projectHost("supabase-staging")).toBe("supabase.red");
    expect(projectHost("supabase-local")).toBe("supabase.red");
    expect(projectHost("snap")).toBe("snapcloud.dev");
  });

  it("falls back to supabase.co for unknown / YAML-mode profiles", () => {
    expect(projectHost("custom-profile")).toBe("supabase.co");
  });
});

describe("poolerHost", () => {
  it("maps built-in profile names to the Go pooler_host", () => {
    expect(poolerHost("supabase")).toBe("supabase.com");
    expect(poolerHost("supabase-staging")).toBe("supabase.green");
    expect(poolerHost("snap")).toBe("snapcloud.co");
  });

  it("returns an empty pooler_host for supabase-local (no domain assertion)", () => {
    expect(poolerHost("supabase-local")).toBe("");
  });

  it("falls back to supabase.com for unknown / YAML-mode profiles", () => {
    expect(poolerHost("custom-profile")).toBe("supabase.com");
  });
});

describe("dashboardUrl", () => {
  it("maps built-in profile names to the Go dashboard_url", () => {
    expect(dashboardUrl("supabase")).toBe("https://supabase.com/dashboard");
    expect(dashboardUrl("supabase-staging")).toBe("https://supabase.green/dashboard");
    expect(dashboardUrl("supabase-local")).toBe("http://localhost:8082");
  });

  it("falls back to the production dashboard for unknown profiles", () => {
    expect(dashboardUrl("custom-profile")).toBe("https://supabase.com/dashboard");
  });
});

describe("billingUrl", () => {
  it("composes the dashboard URL with /org/<slug>/billing", () => {
    expect(billingUrl("supabase", "acme")).toBe("https://supabase.com/dashboard/org/acme/billing");
    expect(billingUrl("supabase-staging", "acme")).toBe(
      "https://supabase.green/dashboard/org/acme/billing",
    );
  });
});
