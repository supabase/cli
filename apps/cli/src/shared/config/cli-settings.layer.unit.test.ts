import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import {
  mockCliProjectContext,
  mockRuntimeInfo,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { getEffectiveConsent } from "../telemetry/consent.ts";
import { CliSettings } from "./cli-settings.service.ts";
import { cliSettingsLayer } from "./cli-settings.layer.ts";
import { cliProjectContextLayer } from "./cli-project-context.layer.ts";
import { CliProjectContext } from "./cli-project-context.service.ts";

const makeTempDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "supabase-cli-settings-" }),
);

function buildLayer(
  path: Path.Path,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    providerEnv?: Record<string, string>;
    homeDir?: string;
  },
) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.homeDir ?? path.join(opts.cwd, ".home"),
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  const discoveredCliProjectContextLayer = cliProjectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
  const discoveredCliSettingsLayer = cliSettingsLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredCliProjectContextLayer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord(opts.providerEnv ?? opts.env ?? {}, {
          preserveEmptyStrings: true,
        }),
      ),
    ),
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
  for (const optOut of ["SUPABASE_TELEMETRY_DISABLED", "DO_NOT_TRACK"]) {
    it.live(`honors injected ${optOut} alongside discovered project settings`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fs.makeDirectory(path.join(cwd, "supabase"));
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "config.toml"),
          'project_id = "demo"\n',
        );
        yield* fs.writeFileString(path.join(cwd, "supabase", ".env"), "SUPABASE_DEBUG=\n");
        yield* Effect.gen(function* () {
          const settings = yield* CliSettings;
          expect(settings.debug).toEqual(Option.some(""));
          expect(yield* getEffectiveConsent(Option.none())).toBe("denied");
        }).pipe(
          Effect.provide(
            buildLayer(path, { cwd, providerEnv: { [optOut]: "1", SUPABASE_DEBUG: "true" } }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  }

  it.live("falls back to ambient env when no Supabase project is found", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      yield* Effect.gen(function* () {
        const cliSettings = yield* CliSettings;
        const cliProjectContext = yield* CliProjectContext;

        expect(cliSettings.apiUrl).toBe("https://ambient.example");
        expect(Option.isNone(cliProjectContext.paths)).toBe(true);
      }).pipe(
        Effect.provide(
          buildLayer(path, {
            cwd: tempDir,
            env: {
              SUPABASE_API_URL: "https://ambient.example",
            },
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live(
    "uses the nearest discovered project and loads supabase/.env.local over supabase/.env",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* makeTempDir;
        const repoRoot = path.join(tempDir, "repo");
        const packageRoot = path.join(repoRoot, "apps", "web");
        const cwd = path.join(packageRoot, "src");

        yield* fs.makeDirectory(path.join(repoRoot, "supabase"), { recursive: true });
        yield* fs.makeDirectory(path.join(packageRoot, "supabase"), { recursive: true });
        yield* fs.makeDirectory(cwd, { recursive: true });
        yield* fs.writeFileString(
          path.join(repoRoot, "supabase", "config.toml"),
          'project_id = "repo"\n',
        );
        yield* fs.writeFileString(
          path.join(repoRoot, "supabase", ".env"),
          "SUPABASE_API_URL=https://repo.example\n",
        );
        yield* fs.writeFileString(
          path.join(packageRoot, "supabase", "config.toml"),
          'project_id = "web"\n',
        );
        yield* fs.writeFileString(
          path.join(packageRoot, "supabase", ".env"),
          "SUPABASE_API_URL=https://shared.example\nSUPABASE_DASHBOARD_URL=https://dashboard.example\n",
        );
        yield* fs.writeFileString(
          path.join(packageRoot, "supabase", ".env.local"),
          "SUPABASE_API_URL=https://local.example\n",
        );

        const { cliSettings, cliProjectContext } = yield* Effect.gen(function* () {
          return {
            cliSettings: yield* CliSettings,
            cliProjectContext: yield* CliProjectContext,
          };
        }).pipe(Effect.provide(buildLayer(path, { cwd })));

        expect(cliSettings.apiUrl).toBe("https://local.example");
        expect(cliSettings.dashboardUrl).toBe("https://dashboard.example");
        expect(Option.isSome(cliProjectContext.paths)).toBe(true);
        if (Option.isSome(cliProjectContext.paths)) {
          expect(cliProjectContext.paths.value.projectRoot).toBe(packageRoot);
        }
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("lets ambient env override discovered project env", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");

      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        'project_id = "repo"\n',
      );
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", ".env"),
        "SUPABASE_API_URL=https://from-dotenv.example\nSUPABASE_ACCESS_TOKEN=sbp_dotenv\n",
      );
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", ".env.local"),
        "SUPABASE_ACCESS_TOKEN=sbp_local\n",
      );

      const cliSettings = yield* CliSettings.pipe(
        Effect.provide(
          buildLayer(path, {
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
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("has no PostHog key when nothing is injected or overridden", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const cliSettings = yield* CliSettings.pipe(
        Effect.provide(buildLayer(path, { cwd: tempDir })),
      );

      expect(Option.isNone(cliSettings.telemetryPosthogKey)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("preserves empty runtime settings as present options", () => {
    const settingsLayer = cliSettingsLayer.pipe(
      Layer.provide(BunServices.layer),
      Layer.provide(mockRuntimeInfo({ cwd: "/test/cwd", homeDir: "/test/home" })),
      Layer.provide(mockCliProjectContext()),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord(
            {
              SUPABASE_NO_KEYRING: "",
              SUPABASE_DEBUG: "",
              SUPABASE_TELEMETRY_DISABLED: "",
            },
            { preserveEmptyStrings: true },
          ),
        ),
      ),
    );
    return Effect.gen(function* () {
      const cliSettings = yield* CliSettings;

      expect(cliSettings.noKeyring).toEqual(Option.some(""));
      expect(cliSettings.debug).toEqual(Option.some(""));
      expect(cliSettings.telemetryDisabled).toEqual(Option.some(""));
    }).pipe(Effect.provide(settingsLayer));
  });

  it.live("prefers SUPABASE_TELEMETRY_POSTHOG_KEY over the shipped default", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const cliSettings = yield* CliSettings.pipe(
        Effect.provide(
          buildLayer(path, {
            cwd: tempDir,
            env: {
              SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_env_override",
            },
          }),
        ),
      );

      expect(cliSettings.telemetryPosthogKey).toEqual(Option.some("phc_env_override"));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("uses SUPABASE_HOME (trimmed) when configured", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const supabaseHome = path.join(tempDir, "custom-supabase-home");
      const cliSettings = yield* CliSettings.pipe(
        Effect.provide(
          buildLayer(path, { cwd: tempDir, env: { SUPABASE_HOME: `  ${supabaseHome}  ` } }),
        ),
      );

      expect(cliSettings.supabaseHome).toBe(supabaseHome);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  for (const value of ["", "   "]) {
    it.live(
      `falls back to <homeDir>/.supabase when SUPABASE_HOME is ${JSON.stringify(value)}`,
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const tempDir = yield* makeTempDir;
          const homeDir = path.join(tempDir, "home");
          const cliSettings = yield* CliSettings.pipe(
            Effect.provide(
              buildLayer(path, { cwd: tempDir, homeDir, env: { SUPABASE_HOME: value } }),
            ),
          );

          expect(cliSettings.supabaseHome).toBe(path.join(homeDir, ".supabase"));
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  }

  it.live("uses the build-injected PostHog key and host when no runtime override is set", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const cliSettings = yield* CliSettings.pipe(
        Effect.provide(
          buildLayer(path, {
            cwd: tempDir,
            env: {
              SUPABASE_CLI_POSTHOG_HOST: "https://build-posthog.example",
              SUPABASE_CLI_POSTHOG_KEY: "phc_build_key",
            },
          }),
        ),
      );

      expect(cliSettings.telemetryPosthogHost).toBe("https://build-posthog.example");
      expect(cliSettings.telemetryPosthogKey).toEqual(Option.some("phc_build_key"));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
