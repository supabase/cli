import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import {
  legacyLoadProfile,
  legacyPadGoErrorBlock,
  type LegacyProfileLoadError,
} from "./legacy-profile-load.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "supabase-profile-load-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const load = (token: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* legacyLoadProfile(token, fs)).apiUrl;
  }).pipe(Effect.provide(BunServices.layer));

const loadError = (token: string) =>
  load(token).pipe(
    Effect.flip,
    Effect.map((error: LegacyProfileLoadError) => error.message),
  );

const writeProfile = (name: string, content: string): string => {
  const filePath = join(tempRoot, name);
  writeFileSync(filePath, content);
  return filePath;
};

describe("legacyLoadProfile", () => {
  it.effect("resolves built-in profile names case-insensitively (Go strings.EqualFold)", () =>
    Effect.gen(function* () {
      // Binary-verified: `--profile SUPABASE-LOCAL` targets localhost:8080.
      expect(yield* load("SUPABASE-LOCAL")).toBe("http://localhost:8080");
      expect(yield* load("supabase")).toBe("https://api.supabase.com");
      expect(yield* load("supabase-staging")).toBe("https://api.supabase.green");
      expect(yield* load("snap")).toBe("https://cloudapi.snap.com");
    }),
  );

  it.effect("fails on an empty token with viper's search-mode error (Go `--profile=`)", () =>
    Effect.gen(function* () {
      expect(yield* loadError("")).toBe(
        `failed to read profile: Config File "config" Not Found in "[]"`,
      );
    }),
  );

  it.effect("fails on a token without a supported extension (flag-shaped tokens)", () =>
    Effect.gen(function* () {
      // `--profile --metadata-url …`: pflag binds the flag-shaped token and Go
      // fails viper's extension gate (binary-verified, PR #5974 round 7).
      expect(yield* loadError("--metadata-url")).toBe(
        `failed to read profile: Unsupported Config Type ""`,
      );
      expect(yield* loadError("profile.txt")).toBe(
        `failed to read profile: Unsupported Config Type "txt"`,
      );
    }),
  );

  it.effect("uses Go filepath.Ext semantics for dot-files (`.yml` IS extension `yml`)", () =>
    Effect.gen(function* () {
      // Node's `path.extname(".yml")` is "" — Go's filepath.Ext is ".yml", so
      // viper accepts the type and fails at the open() instead.
      expect(yield* loadError(join(tempRoot, ".yml"))).toBe(
        `failed to read profile: open ${join(tempRoot, ".yml")}: no such file or directory`,
      );
    }),
  );

  it.effect("fails on a missing file with Go's os.Open error", () =>
    Effect.gen(function* () {
      expect(yield* loadError("missing.yml")).toBe(
        `failed to read profile: open missing.yml: no such file or directory`,
      );
    }),
  );

  it.effect("fails on a directory with Go's read error", () =>
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

  it.effect("accepts mixed-case keys like viper's insensitive decode (probed on go1.26)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // `Name:` / `API_URL:` decode exactly like their lowercase spellings
      // (viper `insensitiviseMap`; review r3689635101).
      const file = writeProfile(
        "mixed-case.yml",
        [
          "Name: harness",
          "API_URL: http://127.0.0.1:44444",
          "dashboard_url: http://127.0.0.1:44444/dashboard",
          "Project_Host: supabase.co",
        ].join("\n"),
      );
      const profile = yield* legacyLoadProfile(file, fs);
      expect(profile.apiUrl).toBe("http://127.0.0.1:44444");
      expect(profile.name).toBe("harness");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports unknown keys LOWERCASED, like viper's pre-decode normalization", () =>
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
      expect(yield* loadError(file)).toContain("'utils.Profile' has invalid keys: bogus_key");
    }),
  );

  it.effect(
    "returns Go's CurrentProfile.Name — the canonical built-in or the file's name field",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Built-in: EqualFold match resolves to the canonical (lower-case)
        // table name — the keyring account Go reads (`access_token.go:43`).
        expect((yield* legacyLoadProfile("SUPABASE-LOCAL", fs)).name).toBe("supabase-local");
        // File profile: `UnmarshalExact` populates Name from the required
        // `name:` key, NOT from the file path.
        const file = writeProfile(
          "named.yml",
          [
            "name: harness",
            "api_url: http://127.0.0.1:44444",
            "dashboard_url: http://127.0.0.1:44444/dashboard",
            "project_host: supabase.co",
          ].join("\n"),
        );
        expect((yield* legacyLoadProfile(file, fs)).name).toBe("harness");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects unknown keys with mapstructure's padded UnmarshalExact block", () =>
    Effect.gen(function* () {
      // Byte-captured from the Go binary (`od -c`, PR #5974 round 7): keys
      // sorted, every line padded with spaces to the longest line's width.
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
      const line1 = "failed to parse profile: decoding failed due to the following error(s):";
      const line3 = "'utils.Profile' has invalid keys: db_url, gotrue_url";
      expect(yield* loadError(file)).toBe(
        [line1, "".padEnd(line1.length), line3.padEnd(line1.length)].join("\n"),
      );
    }),
  );

  it.effect(
    "reports missing required fields with the validator's padded lines, in struct order",
    () =>
      Effect.gen(function* () {
        // Byte-captured from the Go binary: `invalid profile: ` + one line per
        // failing field (struct order), padded to the longest line's width.
        const file = writeProfile("incomplete.yml", "name: incomplete\n");
        const lines = [
          "invalid profile: Key: 'Profile.APIURL' Error:Field validation for 'APIURL' failed on the 'required' tag",
          "Key: 'Profile.DashboardURL' Error:Field validation for 'DashboardURL' failed on the 'required' tag",
          "Key: 'Profile.ProjectHost' Error:Field validation for 'ProjectHost' failed on the 'required' tag",
        ];
        const width = Math.max(...lines.map((line) => line.length));
        expect(yield* loadError(file)).toBe(lines.map((line) => line.padEnd(width)).join("\n"));
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
      expect(yield* loadError(file)).toBe(
        "invalid profile: Key: 'Profile.Name' Error:Field validation for 'Name' failed on the 'required' tag",
      );
    }),
  );

  it.effect(
    "weakly stringifies scalars like viper, so `api_url: 123` fails http_url, not decoding",
    () =>
      Effect.gen(function* () {
        // Binary-verified: viper decodes with WeaklyTypedInput, so the int
        // reaches go-playground/validator and fails the `http_url` tag.
        const file = writeProfile(
          "typebad.yml",
          [
            "name: t",
            "api_url: 123",
            "dashboard_url: http://127.0.0.1:44444/dashboard",
            "project_host: supabase.co",
          ].join("\n"),
        );
        expect(yield* loadError(file)).toBe(
          "invalid profile: Key: 'Profile.APIURL' Error:Field validation for 'APIURL' failed on the 'http_url' tag",
        );
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
      const lines = [
        "invalid profile: Key: 'Profile.APIURL' Error:Field validation for 'APIURL' failed on the 'http_url' tag",
        "Key: 'Profile.ProjectHost' Error:Field validation for 'ProjectHost' failed on the 'hostname_rfc1123' tag",
      ];
      const width = Math.max(...lines.map((line) => line.length));
      expect(yield* loadError(file)).toBe(lines.map((line) => line.padEnd(width)).join("\n"));
    }),
  );

  it.effect("fails a malformed YAML file closed with viper's parse prefix", () =>
    Effect.gen(function* () {
      // Detail text comes from the JS yaml package (documented micro-
      // divergence); the class — abort before any request — matches Go.
      const file = writeProfile("malformed.yml", "name: [broken\n  api_url");
      const message = yield* loadError(file);
      expect(message).toMatch(/^failed to read profile: While parsing config: /);
    }),
  );

  it.effect("fails closed on unconvertible values (array on a string field)", () =>
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
      expect(message).toContain(
        "failed to parse profile: decoding failed due to the following error(s):",
      );
      expect(message).toContain(
        "'APIURL' expected type 'string', got unconvertible type '[]interface {}'",
      );
    }),
  );
});

describe("legacyPadGoErrorBlock", () => {
  it("pads every line — including blank ones — to the longest line's width", () => {
    expect(legacyPadGoErrorBlock("abc\n\nlonger line")).toBe(
      "abc        \n           \nlonger line",
    );
  });

  it("leaves single-line messages untouched", () => {
    expect(legacyPadGoErrorBlock("only line")).toBe("only line");
  });
});
