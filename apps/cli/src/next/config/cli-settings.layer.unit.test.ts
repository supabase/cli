import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Redacted } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { CliSettings } from "./cli-settings.service.ts";
import { cliSettingsLayer } from "./cli-settings.layer.ts";
import { cliProjectContextLayer } from "./cli-project-context.layer.ts";
import { CliProjectContext } from "./cli-project-context.service.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-cli-settings-"));
}

function buildLayer(opts: { cwd: string; env?: Record<string, string>; homeDir?: string }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.homeDir ?? join(opts.cwd, ".home"),
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  const discoveredCliProjectContextLayer = cliProjectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
  const discoveredCliSettingsLayer = cliSettingsLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredCliProjectContextLayer),
  );

  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    envLayer,
    discoveredCliProjectContextLayer,
    discoveredCliSettingsLayer,
  );
}

describe("cliSettingsLayer", () => {
  it.live("falls back to ambient env when no Supabase project is found", () => {
    const tempDir = makeTempDir();
    return Effect.gen(function* () {
      const cliSettings = yield* CliSettings;
      const cliProjectContext = yield* CliProjectContext;

      expect(cliSettings.apiUrl).toBe("https://ambient.example");
      expect(Option.isNone(cliProjectContext.paths)).toBe(true);
    }).pipe(
      Effect.provide(
        buildLayer({
          cwd: tempDir,
          env: {
            SUPABASE_API_URL: "https://ambient.example",
          },
        }),
      ),
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live(
    "uses the nearest discovered project and loads supabase/.env.local over supabase/.env",
    () => {
      const tempDir = makeTempDir();
      const repoRoot = join(tempDir, "repo");
      const packageRoot = join(repoRoot, "apps", "web");
      const cwd = join(packageRoot, "src");

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => mkdir(join(repoRoot, "supabase"), { recursive: true }));
        yield* Effect.tryPromise(() => mkdir(join(packageRoot, "supabase"), { recursive: true }));
        yield* Effect.tryPromise(() => mkdir(cwd, { recursive: true }));
        yield* Effect.tryPromise(() =>
          writeFile(join(repoRoot, "supabase", "config.toml"), 'project_id = "repo"\n'),
        );
        yield* Effect.tryPromise(() =>
          writeFile(join(repoRoot, "supabase", ".env"), "SUPABASE_API_URL=https://repo.example\n"),
        );
        yield* Effect.tryPromise(() =>
          writeFile(join(packageRoot, "supabase", "config.toml"), 'project_id = "web"\n'),
        );
        yield* Effect.tryPromise(() =>
          writeFile(
            join(packageRoot, "supabase", ".env"),
            "SUPABASE_API_URL=https://shared.example\nSUPABASE_DASHBOARD_URL=https://dashboard.example\n",
          ),
        );
        yield* Effect.tryPromise(() =>
          writeFile(
            join(packageRoot, "supabase", ".env.local"),
            "SUPABASE_API_URL=https://local.example\n",
          ),
        );

        const { cliSettings, cliProjectContext } = yield* Effect.gen(function* () {
          return {
            cliSettings: yield* CliSettings,
            cliProjectContext: yield* CliProjectContext,
          };
        }).pipe(Effect.provide(buildLayer({ cwd })));

        expect(cliSettings.apiUrl).toBe("https://local.example");
        expect(cliSettings.dashboardUrl).toBe("https://dashboard.example");
        expect(Option.isSome(cliProjectContext.paths)).toBe(true);
        if (Option.isSome(cliProjectContext.paths)) {
          expect(cliProjectContext.paths.value.projectRoot).toBe(packageRoot);
        }
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live("lets ambient env override discovered project env", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, "supabase", "config.toml"), 'project_id = "repo"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(
          join(projectRoot, "supabase", ".env"),
          "SUPABASE_API_URL=https://from-dotenv.example\nSUPABASE_ACCESS_TOKEN=sbp_dotenv\n",
        ),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, "supabase", ".env.local"), "SUPABASE_ACCESS_TOKEN=sbp_local\n"),
      );

      const cliSettings = yield* Effect.gen(function* () {
        return yield* CliSettings;
      }).pipe(
        Effect.provide(
          buildLayer({
            cwd: projectRoot,
            env: {
              SUPABASE_API_URL: "https://from-ambient.example",
              SUPABASE_ACCESS_TOKEN: "sbp_ambient",
            },
          }),
        ),
      );

      expect(cliSettings.apiUrl).toBe("https://from-ambient.example");
      expect(Option.isSome(cliSettings.accessToken)).toBe(true);
      if (Option.isSome(cliSettings.accessToken)) {
        expect(Redacted.value(cliSettings.accessToken.value)).toBe("sbp_ambient");
      }
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("has no PostHog key when nothing is injected or overridden", () => {
    const tempDir = makeTempDir();
    return Effect.gen(function* () {
      const cliSettings = yield* CliSettings;

      expect(Option.isNone(cliSettings.telemetryPosthogKey)).toBe(true);
    }).pipe(
      Effect.provide(buildLayer({ cwd: tempDir })),
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("prefers SUPABASE_TELEMETRY_POSTHOG_KEY over the shipped default", () => {
    const tempDir = makeTempDir();
    return Effect.gen(function* () {
      const cliSettings = yield* CliSettings;

      expect(cliSettings.telemetryPosthogKey).toEqual(Option.some("phc_env_override"));
    }).pipe(
      Effect.provide(
        buildLayer({
          cwd: tempDir,
          env: {
            SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_env_override",
          },
        }),
      ),
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("uses SUPABASE_HOME (trimmed) when configured", () => {
    const tempDir = makeTempDir();
    const supabaseHome = join(tempDir, "custom-supabase-home");
    return Effect.gen(function* () {
      const cliSettings = yield* CliSettings;

      expect(cliSettings.supabaseHome).toBe(supabaseHome);
    }).pipe(
      Effect.provide(buildLayer({ cwd: tempDir, env: { SUPABASE_HOME: `  ${supabaseHome}  ` } })),
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  for (const value of ["", "   "]) {
    it.live(
      `falls back to <homeDir>/.supabase when SUPABASE_HOME is ${JSON.stringify(value)}`,
      () => {
        const tempDir = makeTempDir();
        const homeDir = join(tempDir, "home");
        return Effect.gen(function* () {
          const cliSettings = yield* CliSettings;

          expect(cliSettings.supabaseHome).toBe(join(homeDir, ".supabase"));
        }).pipe(
          Effect.provide(buildLayer({ cwd: tempDir, homeDir, env: { SUPABASE_HOME: value } })),
          Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
        );
      },
    );
  }

  it.live("uses the build-injected PostHog key and host when no runtime override is set", () => {
    const tempDir = makeTempDir();
    return Effect.gen(function* () {
      const cliSettings = yield* CliSettings;

      expect(cliSettings.telemetryPosthogHost).toBe("https://build-posthog.example");
      expect(cliSettings.telemetryPosthogKey).toEqual(Option.some("phc_build_key"));
    }).pipe(
      Effect.provide(
        buildLayer({
          cwd: tempDir,
          env: {
            SUPABASE_CLI_POSTHOG_HOST: "https://build-posthog.example",
            SUPABASE_CLI_POSTHOG_KEY: "phc_build_key",
          },
        }),
      ),
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
