import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { CliConfig } from "../../next/config/cli-config.service.ts";
import { ProjectContext } from "../../next/config/project-context.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { LegacyCliConfig } from "./legacy-cli-config.service.ts";
import { legacyNextCliConfigLayer } from "./legacy-next-cli-config.layer.ts";
import { cliConfigFromLegacyProfile } from "./legacy-next-cli-config.ts";

describe("cliConfigFromLegacyProfile", () => {
  it("copies the resolved legacy profile endpoints onto next CliConfig", () => {
    const config = cliConfigFromLegacyProfile({
      apiUrl: "https://api.supabase.green",
      dashboardUrl: "https://supabase.green/dashboard",
      projectHost: "supabase.red",
      accessToken: Option.some(Redacted.make("sbp_staging", { label: "token" })),
      homeDir: "/Users/me",
      env: {},
    });
    expect(config.apiUrl).toBe("https://api.supabase.green");
    expect(config.dashboardUrl).toBe("https://supabase.green/dashboard");
    expect(config.projectHost).toBe("supabase.red");
    expect(config.supabaseHome).toBe("/Users/me/.supabase");
    expect(Option.isSome(config.accessToken)).toBe(true);
    if (Option.isSome(config.accessToken)) {
      expect(Redacted.value(config.accessToken.value)).toBe("sbp_staging");
    }
  });

  it("honors SUPABASE_HOME from the environment", () => {
    const config = cliConfigFromLegacyProfile({
      apiUrl: "https://api.supabase.com",
      dashboardUrl: "https://supabase.com/dashboard",
      projectHost: "supabase.co",
      accessToken: Option.none(),
      homeDir: "/Users/me",
      env: { SUPABASE_HOME: "/tmp/supabase-home" },
    });
    expect(config.supabaseHome).toBe("/tmp/supabase-home");
  });

  it.live("provides next CliConfig from a resolved staging LegacyCliConfig", () =>
    Effect.gen(function* () {
      const config = yield* CliConfig;
      expect(config.apiUrl).toBe("https://api.supabase.green");
      expect(config.dashboardUrl).toBe("https://supabase.green/dashboard");
      expect(config.projectHost).toBe("supabase.red");
    }).pipe(
      Effect.provide(legacyNextCliConfigLayer),
      Effect.provide(
        Layer.succeed(LegacyCliConfig, {
          profile: "supabase-staging",
          apiUrl: "https://api.supabase.green",
          projectHost: "supabase.red",
          poolerHost: "supabase.green",
          dashboardUrl: "https://supabase.green/dashboard",
          accessToken: Option.none(),
          projectId: Option.none(),
          workdir: "/tmp",
          userAgent: "SupabaseCLI/test",
        }),
      ),
      Effect.provide(
        Layer.succeed(
          RuntimeInfo,
          RuntimeInfo.of({
            cwd: "/tmp",
            platform: process.platform,
            arch: process.arch,
            homeDir: "/tmp/home",
            execPath: process.execPath,
            pid: process.pid,
          }),
        ),
      ),
    ),
  );

  it.live("resolves supabaseHome from ProjectContext.projectEnv", () =>
    Effect.gen(function* () {
      const config = yield* CliConfig;
      expect(config.supabaseHome).toBe("/tmp/from-project-env");
    }).pipe(
      Effect.provide(legacyNextCliConfigLayer),
      Effect.provide(
        Layer.succeed(LegacyCliConfig, {
          profile: "supabase",
          apiUrl: "https://api.supabase.com",
          projectHost: "supabase.co",
          poolerHost: "supabase.com",
          dashboardUrl: "https://supabase.com/dashboard",
          accessToken: Option.none(),
          projectId: Option.none(),
          workdir: "/tmp",
          userAgent: "SupabaseCLI/test",
        }),
      ),
      Effect.provide(
        Layer.succeed(
          RuntimeInfo,
          RuntimeInfo.of({
            cwd: "/tmp",
            platform: process.platform,
            arch: process.arch,
            homeDir: "/tmp/home",
            execPath: process.execPath,
            pid: process.pid,
          }),
        ),
      ),
      Effect.provide(
        Layer.succeed(ProjectContext, {
          paths: Option.none(),
          projectEnv: Option.some({
            paths: {
              projectRoot: "/tmp/proj",
              supabaseDir: "/tmp/proj/supabase",
              configPath: "/tmp/proj/supabase/config.toml",
              envPath: "/tmp/proj/supabase/.env",
              envLocalPath: "/tmp/proj/supabase/.env.local",
            },
            values: { SUPABASE_HOME: "/tmp/from-project-env" },
            loadedPaths: [],
            sources: {},
          }),
        }),
      ),
    ),
  );
});
