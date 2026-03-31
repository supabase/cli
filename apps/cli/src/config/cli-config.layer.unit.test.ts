import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Redacted } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../tests/helpers/mocks.ts";
import { CliConfig } from "./cli-config.service.ts";
import { cliConfigLayer } from "./cli-config.layer.ts";
import { projectContextLayer } from "./project-context.layer.ts";
import { ProjectContext } from "./project-context.service.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-cli-config-"));
}

function buildLayer(opts: { cwd: string; env?: Record<string, string>; homeDir?: string }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.homeDir ?? join(opts.cwd, ".home"),
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
  );

  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    envLayer,
    discoveredProjectContextLayer,
    discoveredCliConfigLayer,
  );
}

describe("cliConfigLayer", () => {
  it.live("falls back to ambient env when no Supabase project is found", () => {
    const tempDir = makeTempDir();
    return Effect.gen(function* () {
      const cliConfig = yield* CliConfig;
      const projectContext = yield* ProjectContext;

      expect(cliConfig.apiUrl).toBe("https://ambient.example");
      expect(Option.isNone(projectContext.paths)).toBe(true);
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

        const { cliConfig, projectContext } = yield* Effect.gen(function* () {
          return {
            cliConfig: yield* CliConfig,
            projectContext: yield* ProjectContext,
          };
        }).pipe(Effect.provide(buildLayer({ cwd })));

        expect(cliConfig.apiUrl).toBe("https://local.example");
        expect(cliConfig.dashboardUrl).toBe("https://dashboard.example");
        expect(Option.isSome(projectContext.paths)).toBe(true);
        if (Option.isSome(projectContext.paths)) {
          expect(projectContext.paths.value.projectRoot).toBe(packageRoot);
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

      const cliConfig = yield* Effect.gen(function* () {
        return yield* CliConfig;
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

      expect(cliConfig.apiUrl).toBe("https://from-ambient.example");
      expect(Option.isSome(cliConfig.accessToken)).toBe(true);
      if (Option.isSome(cliConfig.accessToken)) {
        expect(Redacted.value(cliConfig.accessToken.value)).toBe("sbp_ambient");
      }
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("falls back to the shipped PostHog key when no env override is set", () => {
    const tempDir = makeTempDir();
    return Effect.gen(function* () {
      const cliConfig = yield* CliConfig;

      expect(cliConfig.telemetryPosthogKey).toMatch(/^phc_/);
    }).pipe(
      Effect.provide(buildLayer({ cwd: tempDir })),
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("prefers SUPABASE_TELEMETRY_POSTHOG_KEY over the shipped default", () => {
    const tempDir = makeTempDir();
    return Effect.gen(function* () {
      const cliConfig = yield* CliConfig;

      expect(cliConfig.telemetryPosthogKey).toBe("phc_env_override");
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
});
