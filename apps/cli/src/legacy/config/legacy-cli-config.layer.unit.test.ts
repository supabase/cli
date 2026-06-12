import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterEach, beforeEach, vi } from "vitest";

import {
  LegacyDebugFlag,
  LegacyProfileFlag,
  LegacyWorkdirFlag,
} from "../../shared/legacy/global-flags.ts";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { legacyDebugLoggerLayer } from "../shared/legacy-debug-logger.layer.ts";
import { legacyCliConfigLayer } from "./legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "./legacy-cli-config.service.ts";

function makeLayer(opts: {
  profileFlag?: string;
  workdirFlag?: Option.Option<string>;
  env?: Record<string, string | undefined>;
  cwd?: string;
  home?: string;
  debug?: boolean;
}) {
  const profileFlag = opts.profileFlag ?? "supabase";
  const workdirFlag = opts.workdirFlag ?? Option.none<string>();
  return legacyCliConfigLayer.pipe(
    Layer.provide(legacyDebugLoggerLayer),
    Layer.provide(Layer.succeed(LegacyDebugFlag, opts.debug ?? false)),
    Layer.provide(Layer.succeed(LegacyProfileFlag, profileFlag)),
    Layer.provide(Layer.succeed(LegacyWorkdirFlag, workdirFlag)),
    Layer.provide(mockRuntimeInfo({ cwd: opts.cwd ?? "/test/cwd", homeDir: opts.home })),
    Layer.provide(BunServices.layer),
    Layer.provide(processEnvLayer(opts.env ?? {})),
  );
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "supabase-legacy-cli-config-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("legacyCliConfigLayer", () => {
  it.effect("defaults to supabase profile and api.supabase.com when no flags or env", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase");
      expect(config.apiUrl).toBe("https://api.supabase.com");
      expect(config.projectHost).toBe("supabase.co");
      expect(config.poolerHost).toBe("supabase.com");
    }).pipe(Effect.provide(makeLayer({ cwd: tempRoot }))),
  );

  it.effect("uses SUPABASE_PROFILE env when the flag is left at default", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase-staging");
      expect(config.apiUrl).toBe("https://api.supabase.green");
      expect(config.projectHost).toBe("supabase.red");
      expect(config.poolerHost).toBe("supabase.green");
    }).pipe(
      Effect.provide(makeLayer({ env: { SUPABASE_PROFILE: "supabase-staging" }, cwd: tempRoot })),
    ),
  );

  it.effect("uses supabase-local profile and localhost API URL", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.apiUrl).toBe("http://localhost:8080");
    }).pipe(Effect.provide(makeLayer({ profileFlag: "supabase-local", cwd: tempRoot }))),
  );

  it.effect("resolves the snap profile API URL and project host", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.apiUrl).toBe("https://cloudapi.snap.com");
      expect(config.projectHost).toBe("snapcloud.dev");
    }).pipe(Effect.provide(makeLayer({ profileFlag: "snap", cwd: tempRoot }))),
  );

  it.effect("reads the persisted ~/.supabase/profile file when no flag/env is set", () => {
    const home = join(tempRoot, "home");
    mkdirSync(join(home, ".supabase"), { recursive: true });
    writeFileSync(join(home, ".supabase", "profile"), "supabase-staging\n");
    return Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase-staging");
    }).pipe(Effect.provide(makeLayer({ home, cwd: tempRoot })));
  });

  it.effect("debug logs the persisted profile file source", () => {
    const home = join(tempRoot, "home");
    const profilePath = join(home, ".supabase", "profile");
    mkdirSync(join(home, ".supabase"), { recursive: true });
    writeFileSync(profilePath, "supabase-staging\n");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase-staging");
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
        `Loading profile from file: ${profilePath}\n`,
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => stderr.mockRestore())),
      Effect.provide(makeLayer({ home, cwd: tempRoot, debug: true })),
    );
  });

  it.effect("flag and env take precedence over the persisted profile file", () => {
    const home = join(tempRoot, "home");
    mkdirSync(join(home, ".supabase"), { recursive: true });
    writeFileSync(join(home, ".supabase", "profile"), "supabase-staging");
    return Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      // SUPABASE_PROFILE wins over the file.
      expect(config.profile).toBe("supabase-local");
    }).pipe(
      Effect.provide(
        makeLayer({ home, cwd: tempRoot, env: { SUPABASE_PROFILE: "supabase-local" } }),
      ),
    );
  });

  it.effect(
    "falls back to supabase profile when SUPABASE_PROFILE is neither a known name nor a readable file",
    () =>
      Effect.gen(function* () {
        const config = yield* LegacyCliConfig;
        expect(config.profile).toBe("supabase");
        expect(config.apiUrl).toBe("https://api.supabase.com");
      }).pipe(
        Effect.provide(makeLayer({ env: { SUPABASE_PROFILE: "rogue-profile" }, cwd: tempRoot })),
      ),
  );

  it.effect("loads api_url, name, and pooler_host from a YAML profile file", () => {
    const profilePath = join(tempRoot, "profile.yaml");
    writeFileSync(
      profilePath,
      [
        "name: cli-e2e",
        'api_url: "http://127.0.0.1:9999"',
        "project_host: localhost",
        "pooler_host: staging.example.com",
      ].join("\n"),
    );
    return Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("cli-e2e");
      expect(config.apiUrl).toBe("http://127.0.0.1:9999");
      expect(config.projectHost).toBe("localhost");
      expect(config.poolerHost).toBe("staging.example.com");
    }).pipe(Effect.provide(makeLayer({ env: { SUPABASE_PROFILE: profilePath }, cwd: tempRoot })));
  });

  it.effect("defaults project_host to supabase.co and pooler_host to empty when omitted", () => {
    const profilePath = join(tempRoot, "no-host.yaml");
    writeFileSync(profilePath, ["name: cli-e2e", 'api_url: "http://127.0.0.1:9999"'].join("\n"));
    return Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.projectHost).toBe("supabase.co");
      // Go's Profile.PoolerHost is `omitempty`: an absent pooler_host disables the
      // MITM domain assertion rather than falling back to supabase.com.
      expect(config.poolerHost).toBe("");
    }).pipe(Effect.provide(makeLayer({ env: { SUPABASE_PROFILE: profilePath }, cwd: tempRoot })));
  });

  it.effect(
    "falls back to supabase profile when SUPABASE_PROFILE points to a non-existent file",
    () =>
      Effect.gen(function* () {
        const config = yield* LegacyCliConfig;
        expect(config.profile).toBe("supabase");
        expect(config.apiUrl).toBe("https://api.supabase.com");
      }).pipe(
        Effect.provide(
          makeLayer({
            env: { SUPABASE_PROFILE: join(tempRoot, "missing.yaml") },
            cwd: tempRoot,
          }),
        ),
      ),
  );

  it.effect("falls back to supabase profile when SUPABASE_PROFILE points to malformed YAML", () => {
    const profilePath = join(tempRoot, "broken.yaml");
    writeFileSync(profilePath, "::: not yaml :::\n[unbalanced");
    return Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase");
      expect(config.apiUrl).toBe("https://api.supabase.com");
    }).pipe(Effect.provide(makeLayer({ env: { SUPABASE_PROFILE: profilePath }, cwd: tempRoot })));
  });

  it.effect("ignores SUPABASE_API_URL — Go parity", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.apiUrl).toBe("https://api.supabase.com");
    }).pipe(
      Effect.provide(
        makeLayer({ env: { SUPABASE_API_URL: "https://nope.example.com" }, cwd: tempRoot }),
      ),
    ),
  );

  it.effect("captures SUPABASE_ACCESS_TOKEN as a Redacted value", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(Option.isSome(config.accessToken)).toBe(true);
      if (Option.isSome(config.accessToken)) {
        expect(Redacted.value(config.accessToken.value)).toBe("sbp_test");
      }
    }).pipe(
      Effect.provide(makeLayer({ env: { SUPABASE_ACCESS_TOKEN: "sbp_test" }, cwd: tempRoot })),
    ),
  );

  it.effect("captures SUPABASE_PROJECT_ID env", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(Option.getOrUndefined(config.projectId)).toBe("myrefabcdefghijklmno");
    }).pipe(
      Effect.provide(
        makeLayer({ env: { SUPABASE_PROJECT_ID: "myrefabcdefghijklmno" }, cwd: tempRoot }),
      ),
    ),
  );

  it.effect("prefers --workdir flag over env and walk-up", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.workdir).toBe("/flag/workdir");
    }).pipe(
      Effect.provide(
        makeLayer({
          workdirFlag: Option.some("/flag/workdir"),
          env: { SUPABASE_WORKDIR: "/env/workdir" },
          cwd: tempRoot,
        }),
      ),
    ),
  );

  it.effect("uses SUPABASE_WORKDIR env when flag is unset", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.workdir).toBe("/env/workdir");
    }).pipe(
      Effect.provide(makeLayer({ env: { SUPABASE_WORKDIR: "/env/workdir" }, cwd: tempRoot })),
    ),
  );

  it.effect("walks up from CWD looking for supabase/config.toml", () => {
    const projectRoot = join(tempRoot, "project");
    const nested = join(projectRoot, "deep", "child");
    mkdirSync(join(projectRoot, "supabase"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(projectRoot, "supabase", "config.toml"), 'project_id = "x"\n');

    return Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.workdir).toBe(projectRoot);
    }).pipe(Effect.provide(makeLayer({ cwd: nested })));
  });

  it.effect("falls back to CWD when no supabase/config.toml found", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.workdir).toBe(tempRoot);
    }).pipe(Effect.provide(makeLayer({ cwd: tempRoot }))),
  );

  it.effect("populates userAgent from CLI_VERSION", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      // The sentinel `0.0.0-dev` value applies when SUPABASE_CLI_VERSION is unset (tests).
      expect(config.userAgent).toMatch(/^SupabaseCLI\//);
    }).pipe(Effect.provide(makeLayer({ cwd: tempRoot }))),
  );
});
