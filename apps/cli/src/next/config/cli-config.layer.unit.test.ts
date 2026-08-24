import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { CliConfig } from "./cli-config.service.ts";
import { cliConfigLayer } from "./cli-config.layer.ts";
import { projectContextLayer } from "./project-context.layer.ts";
import { ProjectContext } from "./project-context.service.ts";

function buildLayer(opts: { cwd: string; env?: Record<string, string>; homeDir: string }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.homeDir,
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  const discoveredProjectContextLayer = projectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
  const discoveredCliConfigLayer = cliConfigLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredProjectContextLayer),
    Layer.provide(envLayer),
  );

  return Layer.mergeAll(discoveredProjectContextLayer, discoveredCliConfigLayer);
}

describe("cliConfigLayer", () => {
  it.live("falls back to ambient env when no Supabase project is found", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-cli-config-" });
      yield* Effect.gen(function* () {
        const cliConfig = yield* CliConfig;
        const projectContext = yield* ProjectContext;

        expect(cliConfig.apiUrl).toBe("https://ambient.example");
        expect(Option.isNone(projectContext.paths)).toBe(true);
      }).pipe(
        Effect.provide(
          buildLayer({
            cwd: tempDir,
            homeDir: path.join(tempDir, ".home"),
            env: { SUPABASE_API_URL: "https://ambient.example" },
          }),
        ),
        Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)),
      );
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live(
    "uses the nearest discovered project and loads supabase/.env.local over supabase/.env",
    () => {
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-cli-config-" });
        yield* Effect.gen(function* () {
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

          const cliConfig = yield* CliConfig.pipe(
            Effect.provide(buildLayer({ cwd, homeDir: path.join(tempDir, ".home") })),
          );
          const projectContext = yield* ProjectContext.pipe(
            Effect.provide(buildLayer({ cwd, homeDir: path.join(tempDir, ".home") })),
          );

          expect(cliConfig.apiUrl).toBe("https://local.example");
          expect(cliConfig.dashboardUrl).toBe("https://dashboard.example");
          expect(Option.isSome(projectContext.paths)).toBe(true);
          if (Option.isSome(projectContext.paths)) {
            expect(projectContext.paths.value.projectRoot).toBe(packageRoot);
          }
        }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.live("lets ambient env override discovered project env", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-cli-config-" });
      yield* Effect.gen(function* () {
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

        const cliConfig = yield* CliConfig.pipe(
          Effect.provide(
            buildLayer({
              cwd: projectRoot,
              homeDir: path.join(tempDir, ".home"),
              env: {
                SUPABASE_API_URL: "https://from-ambient.example",
                SUPABASE_ACCESS_TOKEN: "sbp_ambient",
              },
            }),
          ),
        );

        expect(cliConfig.apiUrl).toBe("https://from-ambient.example");
        expect(Option.isSome(cliConfig.accessToken)).toBe(true);
        if (Option.isSome(cliConfig.accessToken)) {
          expect(Redacted.value(cliConfig.accessToken.value)).toBe("sbp_ambient");
        }
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("has no PostHog key when nothing is injected or overridden", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-cli-config-" });
      yield* Effect.gen(function* () {
        const cliConfig = yield* CliConfig.pipe(
          Effect.provide(buildLayer({ cwd: tempDir, homeDir: path.join(tempDir, ".home") })),
        );

        expect(Option.isNone(cliConfig.telemetryPosthogKey)).toBe(true);
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("prefers SUPABASE_TELEMETRY_POSTHOG_KEY over the shipped default", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-cli-config-" });
      yield* Effect.gen(function* () {
        const cliConfig = yield* CliConfig.pipe(
          Effect.provide(
            buildLayer({
              cwd: tempDir,
              homeDir: path.join(tempDir, ".home"),
              env: { SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_env_override" },
            }),
          ),
        );

        expect(cliConfig.telemetryPosthogKey).toEqual(Option.some("phc_env_override"));
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("uses SUPABASE_HOME (trimmed) when configured", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-cli-config-" });
      yield* Effect.gen(function* () {
        const supabaseHome = path.join(tempDir, "custom-supabase-home");
        const cliConfig = yield* CliConfig.pipe(
          Effect.provide(
            buildLayer({
              cwd: tempDir,
              homeDir: path.join(tempDir, ".home"),
              env: { SUPABASE_HOME: `  ${supabaseHome}  ` },
            }),
          ),
        );

        expect(cliConfig.supabaseHome).toBe(supabaseHome);
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  for (const value of ["", "   "]) {
    it.live(
      `falls back to <homeDir>/.supabase when SUPABASE_HOME is ${JSON.stringify(value)}`,
      () => {
        return Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-cli-config-" });
          yield* Effect.gen(function* () {
            const homeDir = path.join(tempDir, "home");
            const cliConfig = yield* CliConfig.pipe(
              Effect.provide(buildLayer({ cwd: tempDir, homeDir, env: { SUPABASE_HOME: value } })),
            );

            expect(cliConfig.supabaseHome).toBe(path.join(homeDir, ".supabase"));
          }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
        }).pipe(Effect.provide(BunServices.layer));
      },
    );
  }

  it.live("uses the build-injected PostHog key and host when no runtime override is set", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-cli-config-" });
      yield* Effect.gen(function* () {
        const cliConfig = yield* CliConfig.pipe(
          Effect.provide(
            buildLayer({
              cwd: tempDir,
              homeDir: path.join(tempDir, ".home"),
              env: {
                SUPABASE_CLI_POSTHOG_HOST: "https://build-posthog.example",
                SUPABASE_CLI_POSTHOG_KEY: "phc_build_key",
              },
            }),
          ),
        );

        expect(cliConfig.telemetryPosthogHost).toBe("https://build-posthog.example");
        expect(cliConfig.telemetryPosthogKey).toEqual(Option.some("phc_build_key"));
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });
});
