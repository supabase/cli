import { BunServices } from "@effect/platform-bun";
import { describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { goldenJson, useShellEnvPin } from "../../tests/helpers/config-goldens.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { loadLocalProjectContext } from "./local-project-context.ts";
import { loadStackConfig, StackConfigError } from "./stack-config.ts";

const TARGET_REF = "abcdefghijklmnopqrst";
const STACK_ID = "golden-stack";
const GOLDEN_DIR = "./testdata/config-precedence/stack-config";

const BASE_CONFIG = `project_id = "golden-stack"

[api]
port = 55321
schemas = ["public", "base_api"]

[db]
port = 55322

[auth]
site_url = "http://base.example.com"
enable_signup = true

[studio]
port = 55323

[realtime]
enabled = true

[storage]
enabled = true
`;

const REMOTE_BLOCK = `
[remotes.prod]
project_id = "${TARGET_REF}"

[remotes.prod.api]
schemas = ["public", "remote_api"]

[remotes.prod.auth]
site_url = "http://remote.example.com"
enable_signup = false

[remotes.prod.realtime]
enabled = false
`;

const SHELL_ENV = {
  SUPABASE_API_PORT: "56321",
  SUPABASE_DB_PORT: "56322",
  SUPABASE_API_SCHEMAS: "public,shell_api",
  SUPABASE_AUTH_SITE_URL: "http://shell.example.com",
  SUPABASE_AUTH_ENABLE_SIGNUP: "false",
  SUPABASE_REALTIME_ENABLED: "false",
  SUPABASE_STUDIO_ENABLED: "false",
};

const DOTENV = [
  "SUPABASE_API_PORT=57321",
  "SUPABASE_DB_PORT=57322",
  "SUPABASE_API_SCHEMAS=public,dotenv_api",
  "SUPABASE_AUTH_SITE_URL=http://dotenv.example.com",
  "SUPABASE_AUTH_ENABLE_SIGNUP=false",
  "SUPABASE_REALTIME_ENABLED=false",
  "SUPABASE_STUDIO_ENABLED=false",
  "",
].join("\n");

interface Fixture {
  readonly golden: string;
  readonly name: string;
  readonly config: string;
  readonly shellEnv?: Readonly<Record<string, string>>;
  readonly dotenv?: string;
  readonly contextRef?: string;
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    golden: "no-overrides",
    name: "stack config with base config and no env resolves the base values (pre-refactor)",
    config: BASE_CONFIG,
  },
  {
    golden: "remote-block-ignored",
    name: "stack config ignores a [remotes.*] block because no caller passes a ref (pre-refactor)",
    config: BASE_CONFIG + REMOTE_BLOCK,
    shellEnv: { SUPABASE_REMOTES_PROD_PROJECT_ID: TARGET_REF },
  },
  {
    golden: "remote-block-merged-via-context",
    name: "stack config applies a remote block only when the caller preloads a ref-scoped context (pre-refactor)",
    config: BASE_CONFIG + REMOTE_BLOCK,
    contextRef: TARGET_REF,
  },
  {
    golden: "remote-block-merged-via-context-with-shell-env",
    name: "stack config lets shell env beat a merged remote block for the same keys (pre-refactor)",
    config: BASE_CONFIG + REMOTE_BLOCK,
    shellEnv: SHELL_ENV,
    contextRef: TARGET_REF,
  },
  {
    golden: "shell-env",
    name: "stack config shell env overrides ports, api schemas, auth settings and service gates (pre-refactor)",
    config: BASE_CONFIG,
    shellEnv: SHELL_ENV,
  },
  {
    golden: "project-dotenv",
    name: "stack config supabase/.env overrides ports, api schemas, auth settings and service gates (pre-refactor)",
    config: BASE_CONFIG,
    dotenv: DOTENV,
  },
  {
    golden: "shell-beats-dotenv",
    name: "stack config shell env beats supabase/.env for the same keys (pre-refactor)",
    config: BASE_CONFIG,
    shellEnv: {
      SUPABASE_API_SCHEMAS: "public,shell_api",
      SUPABASE_AUTH_SITE_URL: "http://shell.example.com",
    },
    dotenv: DOTENV,
  },
];

const configEnvOnly = (env: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("SUPABASE_")));

const tempRoot = useTempWorkdir("stack-config-golden-");

describe("stack config precedence goldens", () => {
  const pinShellEnv = useShellEnvPin();

  for (const fixture of FIXTURES) {
    it.live(fixture.name, (ctx) =>
      Effect.gen(function* () {
        const workdir = tempRoot.current;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(workdir, "supabase", "config.toml"), fixture.config);
        if (fixture.dotenv !== undefined) {
          yield* fs.writeFileString(path.join(workdir, "supabase", ".env"), fixture.dotenv);
        }
        pinShellEnv(fixture.shellEnv ?? {});

        const layer = Layer.mergeAll(
          BunServices.layer,
          runtimeInfoLayer,
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord(
              Object.fromEntries(
                Object.entries(process.env).flatMap(([name, value]) =>
                  value === undefined ? [] : [[name, value]],
                ),
              ),
              { preserveEmptyStrings: true },
            ),
          ),
        );

        const config = yield* Effect.gen(function* () {
          const context =
            fixture.contextRef === undefined
              ? undefined
              : yield* loadLocalProjectContext(
                  workdir,
                  (message) => new StackConfigError({ message }),
                  fixture.contextRef,
                );
          return yield* loadStackConfig(workdir, context === undefined ? undefined : { context });
        }).pipe(Effect.provide(layer));

        const creations = yield* config.creations(STACK_ID);
        const keys = yield* config.keys;
        const golden = {
          creations,
          keys,
          source: config.source,
          projectEnvValues: configEnvOnly(config.projectEnvValues),
        };
        yield* Effect.promise(() =>
          ctx
            .expect(goldenJson(golden, { [workdir]: "<WORKDIR>" }))
            .toMatchFileSnapshot(`${GOLDEN_DIR}/${fixture.golden}.json`),
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );
  }
});
