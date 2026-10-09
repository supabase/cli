import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { loadProfile, type ProfileLoadError } from "./profile-load.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "supabase-profile-load-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const load = (token: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* loadProfile(token, fs)).apiUrl;
  }).pipe(Effect.provide(BunServices.layer));

const loadError = (token: string) =>
  load(token).pipe(
    Effect.flip,
    Effect.map((error: ProfileLoadError) => error.message),
  );

const writeProfile = (name: string, content: string): string => {
  const filePath = join(tempRoot, name);
  writeFileSync(filePath, content);
  return filePath;
};

describe("loadProfile", () => {
  it.effect("resolves built-in profile names case-insensitively", () =>
    Effect.gen(function* () {
      expect(yield* load("SUPABASE-LOCAL")).toBe("http://localhost:8080");
      expect(yield* load("supabase")).toBe("https://api.supabase.com");
      expect(yield* load("supabase-staging")).toBe("https://api.supabase.green");
      expect(yield* load("snap")).toBe("https://cloudapi.snap.com");
    }),
  );

  it.effect("fails an empty --profile= token with the search-mode error", () =>
    Effect.gen(function* () {
      expect(yield* loadError("")).toBe(`failed to read profile: no profile config file specified`);
    }),
  );

  it.effect("fails on a token without a supported extension (flag-shaped tokens)", () =>
    Effect.gen(function* () {
      // --profile --metadata-url …
      expect(yield* loadError("--metadata-url")).toBe(
        `failed to read profile: unsupported config file type ""`,
      );
      expect(yield* loadError("profile.txt")).toBe(
        `failed to read profile: unsupported config file type "txt"`,
      );
    }),
  );

  it.effect("treats dot-files as having an extension (`.yml` IS extension `yml`)", () =>
    Effect.gen(function* () {
      expect(yield* loadError(join(tempRoot, ".yml"))).toBe(
        `failed to read profile: open ${join(tempRoot, ".yml")}: no such file or directory`,
      );
    }),
  );

  it.effect("fails on a missing file with the open error", () =>
    Effect.gen(function* () {
      expect(yield* loadError("missing.yml")).toBe(
        `failed to read profile: open missing.yml: no such file or directory`,
      );
    }),
  );

  it.effect("fails on a directory with the read error", () =>
    Effect.gen(function* () {
      const dir = join(tempRoot, "dir.yml");
      mkdirSync(dir, { recursive: true });
      expect(yield* loadError(dir)).toBe(`failed to read profile: read ${dir}: is a directory`);
    }),
  );

  it.effect("resolves a valid YAML profile to its api_url", () =>
    Effect.gen(function* () {
      const file = writeProfile(
        "valid.yml",
        [
          "name: harness",
          "api_url: http://127.0.0.1:44444",
          "dashboard_url: http://127.0.0.1:44444/dashboard",
          "project_host: supabase.co",
        ].join("\n"),
      );
      expect(yield* load(file)).toBe("http://127.0.0.1:44444");
    }),
  );

  it.effect("accepts mixed-case keys case-insensitively", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = writeProfile(
        "mixed-case.yml",
        [
          "Name: harness",
          "API_URL: http://127.0.0.1:44444",
          "dashboard_url: http://127.0.0.1:44444/dashboard",
          "Project_Host: supabase.co",
        ].join("\n"),
      );
      const profile = yield* loadProfile(file, fs);
      expect(profile.apiUrl).toBe("http://127.0.0.1:44444");
      expect(profile.name).toBe("harness");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("returns the full endpoint set for built-in and YAML profiles", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const builtin = yield* loadProfile("supabase-staging", fs);
      expect(builtin.projectHost).toBe("supabase.red");
      expect(builtin.poolerHost).toBe("supabase.green");
      expect(builtin.dashboardUrl).toBe("https://supabase.green/dashboard");
      // pooler_host is omitted below; it's optional and stays empty (disables the MITM
      // assertion).
      const file = writeProfile(
        "endpoints.yml",
        [
          "name: harness",
          "api_url: http://127.0.0.1:44444",
          "dashboard_url: http://127.0.0.1:44444/dashboard",
          "project_host: example.test",
        ].join("\n"),
      );
      const fromFile = yield* loadProfile(file, fs);
      expect(fromFile.projectHost).toBe("example.test");
      expect(fromFile.poolerHost).toBe("");
      expect(fromFile.dashboardUrl).toBe("http://127.0.0.1:44444/dashboard");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports unknown keys LOWERCASED", () =>
    Effect.gen(function* () {
      const file = writeProfile(
        "bogus-upper.yml",
        [
          "name: harness",
          "api_url: http://127.0.0.1:44444",
          "dashboard_url: http://127.0.0.1:44444/dashboard",
          "project_host: supabase.co",
          "BOGUS_KEY: x",
        ].join("\n"),
      );
      expect(yield* loadError(file)).toContain("unknown keys: bogus_key");
    }),
  );

  it.effect("returns the profile name — the canonical built-in or the file's name field", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      expect((yield* loadProfile("SUPABASE-LOCAL", fs)).name).toBe("supabase-local");
      const file = writeProfile(
        "named.yml",
        [
          "name: harness",
          "api_url: http://127.0.0.1:44444",
          "dashboard_url: http://127.0.0.1:44444/dashboard",
          "project_host: supabase.co",
        ].join("\n"),
      );
      expect((yield* loadProfile(file, fs)).name).toBe("harness");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects unknown keys with a sorted unknown-keys line", () =>
    Effect.gen(function* () {
      const file = writeProfile(
        "extra-keys.yml",
        [
          "name: extra",
          "api_url: http://127.0.0.1:44444",
          "dashboard_url: http://127.0.0.1:44444/dashboard",
          "project_host: supabase.co",
          "gotrue_url: http://127.0.0.1:44444/auth",
          "db_url: postgres://localhost:5432/db",
        ].join("\n"),
      );
      expect(yield* loadError(file)).toBe(
        "failed to parse profile:\nunknown keys: db_url, gotrue_url",
      );
    }),
  );

  it.effect("reports missing required fields one per line, in field order", () =>
    Effect.gen(function* () {
      const file = writeProfile("incomplete.yml", "name: incomplete\n");
      expect(yield* loadError(file)).toBe(
        [
          "invalid profile:",
          "api_url is required",
          "dashboard_url is required",
          "project_host is required",
        ].join("\n"),
      );
    }),
  );

  it.effect("reports a missing name (only) — required covers empty strings", () =>
    Effect.gen(function* () {
      const file = writeProfile(
        "noname.yml",
        [
          "api_url: http://127.0.0.1:44444",
          "dashboard_url: http://127.0.0.1:44444/dashboard",
          "project_host: supabase.co",
        ].join("\n"),
      );
      expect(yield* loadError(file)).toBe("invalid profile:\nname is required");
    }),
  );

  it.effect("weakly stringifies scalars, so `api_url: 123` fails http_url, not decoding", () =>
    Effect.gen(function* () {
      const file = writeProfile(
        "typebad.yml",
        [
          "name: t",
          "api_url: 123",
          "dashboard_url: http://127.0.0.1:44444/dashboard",
          "project_host: supabase.co",
        ].join("\n"),
      );
      expect(yield* loadError(file)).toBe("invalid profile:\napi_url must be an http(s) URL");
    }),
  );

  it.effect("validates the hostname_rfc1123 and http_url format tags", () =>
    Effect.gen(function* () {
      const file = writeProfile(
        "badhost.yml",
        [
          "name: t",
          "api_url: not-a-url",
          "dashboard_url: http://127.0.0.1:44444/dashboard",
          "project_host: 'bad host!'",
        ].join("\n"),
      );
      expect(yield* loadError(file)).toBe(
        [
          "invalid profile:",
          "api_url must be an http(s) URL",
          "project_host must be a valid hostname",
        ].join("\n"),
      );
    }),
  );

  it.effect("fails a malformed YAML file closed with the parse-error prefix", () =>
    Effect.gen(function* () {
      const file = writeProfile("malformed.yml", "name: [broken\n  api_url");
      const message = yield* loadError(file);
      expect(message).toMatch(/^failed to read profile: invalid config file: /);
    }),
  );

  it.effect("fails closed on non-scalar values (array on a string field)", () =>
    Effect.gen(function* () {
      const file = writeProfile(
        "arrayval.yml",
        [
          "name: t",
          "api_url: [http://a, http://b]",
          "dashboard_url: http://127.0.0.1:44444/dashboard",
          "project_host: supabase.co",
        ].join("\n"),
      );
      const message = yield* loadError(file);
      expect(message).toBe(
        'failed to parse profile:\napi_url: expected a string, got array: ["http://a","http://b"]',
      );
    }),
  );
});
