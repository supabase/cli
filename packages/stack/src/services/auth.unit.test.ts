import { describe, expect, test } from "vitest";
import { makeAuthServiceDocker, makeAuthServiceNative } from "./auth.ts";

const baseOptions = {
  dbPort: 54322,
  authPort: 54324,
  siteUrl: "http://localhost:3000",
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwtExpiry: 3600,
  externalUrl: "http://127.0.0.1:54321/auth/v1",
  dependencies: [],
};

describe("auth external providers", () => {
  // The contract: `external` is the typed surface for GoTrue OAuth
  // providers, translated to GOTRUE_EXTERNAL_<ID>_* env the way the
  // classic CLI translates [auth.external.*].
  test("native: a declared provider enables with the issuer-derived redirect", () => {
    const def = makeAuthServiceNative({
      ...baseOptions,
      binPath: "/opt/supabase",
      external: { google: { clientId: "client-id", secret: "client-secret" } },
    });

    expect(def.env).toMatchObject({
      GOTRUE_EXTERNAL_GOOGLE_ENABLED: "true",
      GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: "client-id",
      GOTRUE_EXTERNAL_GOOGLE_SECRET: "client-secret",
      GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI: "http://127.0.0.1:54321/auth/v1/callback",
      // Defaults survive beside the provider translation.
      GOTRUE_SITE_URL: "http://localhost:3000",
    });
    // Defaults emit explicitly, url's empty string included: native
    // spawns extend the parent env, so an omitted var would inherit the
    // shell's value (GoTrue reads an empty URL as its provider default).
    expect(def.env).toMatchObject({
      GOTRUE_EXTERNAL_GOOGLE_URL: "",
      GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK: "false",
      GOTRUE_EXTERNAL_GOOGLE_EMAIL_OPTIONAL: "false",
    });
  });

  test("docker: explicit fields reach the container args; enabled=false stays declared", () => {
    const def = makeAuthServiceDocker({
      ...baseOptions,
      image: "supabase/gotrue:test",
      dbHost: "127.0.0.1",
      networkArgs: [],
      apiPort: 54321,
      external: {
        github: {
          enabled: false,
          clientId: "gh-id",
          secret: "gh-secret",
          redirectUri: "http://example.test/cb",
          url: "https://ghe.example.test",
          skipNonceCheck: true,
        },
      },
    });

    const args = def.args ?? [];
    expect(args).toContain("GOTRUE_EXTERNAL_GITHUB_ENABLED=false");
    expect(args).toContain("GOTRUE_EXTERNAL_GITHUB_CLIENT_ID=gh-id");
    expect(args).toContain("GOTRUE_EXTERNAL_GITHUB_SECRET=gh-secret");
    expect(args).toContain("GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI=http://example.test/cb");
    expect(args).toContain("GOTRUE_EXTERNAL_GITHUB_URL=https://ghe.example.test");
    expect(args).toContain("GOTRUE_EXTERNAL_GITHUB_SKIP_NONCE_CHECK=true");
  });

  test("a secretless provider emits an empty secret, like the classic CLI", () => {
    const def = makeAuthServiceNative({
      ...baseOptions,
      binPath: "/opt/supabase",
      external: { apple: { clientId: "apple-id" } },
    });

    expect(def.env).toMatchObject({
      GOTRUE_EXTERNAL_APPLE_ENABLED: "true",
      GOTRUE_EXTERNAL_APPLE_SECRET: "",
    });
  });

  test("empty redirectUri and url mean unset, like the classic surface", () => {
    // The generated config.toml template ships redirect_uri = "" and
    // url = "" — TOML strings can't be absent — and start.go substitutes
    // the derived callback for an empty redirect_uri. The URL var still
    // emits (empty = GoTrue's provider default) so a shell variable can
    // never supply it under native-mode env extension.
    const def = makeAuthServiceNative({
      ...baseOptions,
      binPath: "/opt/supabase",
      external: {
        gitlab: { clientId: "gl-id", secret: "gl-secret", redirectUri: "", url: "" },
      },
    });

    expect(def.env).toMatchObject({
      GOTRUE_EXTERNAL_GITLAB_REDIRECT_URI: "http://127.0.0.1:54321/auth/v1/callback",
      GOTRUE_EXTERNAL_GITLAB_URL: "",
    });
  });

  test("no external config adds no provider env", () => {
    const def = makeAuthServiceNative({ ...baseOptions, binPath: "/opt/supabase" });
    const providerKeys = Object.keys(def.env ?? {}).filter(
      (key) => key.startsWith("GOTRUE_EXTERNAL_") && key !== "GOTRUE_EXTERNAL_EMAIL_ENABLED",
    );
    expect(providerKeys).toEqual([]);
    // Empty but present: [] must mean "no extra redirects", not "whatever
    // the parent shell says".
    expect(def.env).toMatchObject({ GOTRUE_URI_ALLOW_LIST: "" });
  });

  test("additional redirect urls translate to the comma-joined allow list", () => {
    const def = makeAuthServiceNative({
      ...baseOptions,
      binPath: "/opt/supabase",
      additionalRedirectUrls: ["http://localhost:3000", "https://app.example.test"],
    });
    expect(def.env).toMatchObject({
      GOTRUE_URI_ALLOW_LIST: "http://localhost:3000,https://app.example.test",
    });
  });
});
