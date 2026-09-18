import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import type { ServiceCreation } from "@supabase/stack/effect";
import { runtimeInfoLayer } from "../../../shared/runtime/runtime-info.layer.ts";

import { withEnvVar } from "../../../../tests/helpers/command-mocks.ts";
import { loadStackConfig } from "../../../command-internal/stack-config.ts";
import { createStackConfigProject } from "../../../../tests/helpers/stack-config.ts";

const project = (
  config: string,
  options: { readonly rootEnv?: string; readonly supabaseEnv?: string } = {},
) =>
  createStackConfigProject(config, {
    prefix: "supabase-stack-config-env-",
    ...options,
  }).pipe(Effect.provide(BunServices.layer));

const load = (projectRoot: string) =>
  loadStackConfig(projectRoot).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
  );

const withEnvironment = <A, E, R>(
  values: Readonly<Record<string, string | undefined>>,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Object.entries(values).reduce((effect, [name, value]) => withEnvVar(name, value, effect), body);

const service = (services: ReadonlyArray<ServiceCreation>, name: string) =>
  services.find((entry) => entry.service === name);

describe("loadStackConfig environment overrides", () => {
  it.live("uses shell > supabase dotenv > project-root dotenv precedence", () =>
    Effect.gen(function* () {
      const root = yield* project(
        `project_id = "stack-config-env-precedence"
[auth]
site_url = "from-config"
`,
        {
          rootEnv: "SUPABASE_AUTH_SITE_URL=root\nAUTH_SITE_URL=root-indirect\n",
          supabaseEnv: "SUPABASE_AUTH_SITE_URL=supabase\nAUTH_SITE_URL=supabase-indirect\n",
        },
      );
      const shell = yield* withEnvVar("SUPABASE_AUTH_SITE_URL", "shell", load(root));
      expect(shell.source.auth.site_url).toBe("shell");
      const indirect = yield* withEnvVar(
        "SUPABASE_AUTH_SITE_URL",
        "env(AUTH_SITE_URL)",
        load(root),
      );
      expect(indirect.source.auth.site_url).toBe("supabase-indirect");
      const empty = yield* withEnvVar("SUPABASE_AUTH_SITE_URL", "", load(root));
      expect(empty.source.auth.site_url).toBe("from-config");
      const dotenv = yield* withEnvVar("SUPABASE_AUTH_SITE_URL", undefined, load(root));
      expect(dotenv.source.auth.site_url).toBe("supabase");
    }),
  );

  it.live("applies env-only listener ports and leaves omitted ports automatic", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "stack-config-env-only-ports"\n');
      const config = yield* withEnvironment(
        {
          SUPABASE_API_PORT: "54321",
          SUPABASE_DB_PORT: "54322",
          SUPABASE_ANALYTICS_PORT: "55555",
        },
        load(root),
      );
      const recipes = yield* config.creations("env-only-ports");
      expect(service(recipes, "database")?.endpoints).toEqual({ sql: { port: 54322 } });
      expect(service(recipes, "rest")?.endpoints).toEqual({ http: { port: 54321 } });
      expect(service(recipes, "analytics")?.endpoints).toEqual({ http: { port: 55555 } });

      const defaults = yield* load(root);
      const defaultRecipes = yield* defaults.creations("automatic-ports");
      expect(service(defaultRecipes, "analytics")?.endpoints).toEqual({
        http: { port: "auto" },
      });
    }),
  );

  it.live("disables and re-enables Auth through the effective environment layer", () =>
    Effect.gen(function* () {
      const disabledRoot = yield* project('project_id = "stack-config-env-disable"\n', {
        supabaseEnv: "SUPABASE_AUTH_ENABLED=false\n",
      });
      const disabled = yield* load(disabledRoot);
      expect(disabled.source.auth.enabled).toBe(false);
      expect(
        (yield* disabled.creations("disabled")).some(({ service }) => service === "auth"),
      ).toBe(false);

      const enabledRoot = yield* project(
        `project_id = "stack-config-env-enable"
[auth]
enabled = false
`,
      );
      const enabled = yield* withEnvVar("SUPABASE_AUTH_ENABLED", "true", load(enabledRoot));
      expect(enabled.source.auth.enabled).toBe(true);
      expect((yield* enabled.creations("enabled")).some(({ service }) => service === "auth")).toBe(
        true,
      );
    }),
  );

  it.live("reports malformed environment ports as configuration errors", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "stack-config-env-invalid-port"\n');
      const exit = yield* withEnvVar("SUPABASE_API_PORT", "not-a-port", load(root)).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("api.port");
    }),
  );

  it.live("rejects the existing OrioleDB environment override", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "stack-config-env-orioledb"\n');
      const exit = yield* withEnvVar(
        "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION",
        "15.1.1.14",
        load(root),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(String(exit.cause)).toContain("experimental.orioledb_version");
    }),
  );
});
