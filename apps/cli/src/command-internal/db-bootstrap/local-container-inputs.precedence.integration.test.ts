import { BunServices } from "@effect/platform-bun";
import { describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { cliConfigValuesTestLayer } from "../../../tests/helpers/config-snapshot-layer.ts";
import { mockRuntimeInfo } from "../../../tests/helpers/mocks.ts";
import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { ConfigEnvPins } from "../../../tests/helpers/config-env-pins.ts";
import { goldenJson, useShellEnvPin } from "../../../tests/helpers/config-goldens.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { ExperimentalFlag } from "../global-flags.ts";
import { buildLocalDbContainerInputs } from "./local-container-inputs.ts";

const TARGET_REF = "abcdefghijklmnopqrst";
const GOLDEN_DIR = "./testdata/config-precedence/local-container-inputs";

const BASE_CONFIG = `project_id = "golden-shadow"

[api]
port = 55321
schemas = ["public", "base_api"]

[db]
port = 55322

[auth]
site_url = "http://base.example.com"
enable_signup = true

[realtime]
enabled = true

[storage]
enabled = true

[experimental.pgdelta]
enabled = false
`;

const REMOTE_BLOCK = `
[remotes.prod]
project_id = "${TARGET_REF}"

[remotes.prod.api]
schemas = ["public", "remote_api"]

[remotes.prod.auth]
site_url = "http://remote.example.com"
enable_signup = false

[remotes.prod.db]
port = 58322
`;

const SHELL_ENV = {
  SUPABASE_DB_PORT: "56322",
  SUPABASE_API_SCHEMAS: "public,shell_api",
  SUPABASE_AUTH_SITE_URL: "http://shell.example.com",
  SUPABASE_AUTH_ENABLE_SIGNUP: "false",
  SUPABASE_REALTIME_ENABLED: "false",
  SUPABASE_STORAGE_ENABLED: "false",
};

const DOTENV = [
  "SUPABASE_DB_PORT=57322",
  "SUPABASE_API_SCHEMAS=public,dotenv_api",
  "SUPABASE_AUTH_SITE_URL=http://dotenv.example.com",
  "SUPABASE_AUTH_ENABLE_SIGNUP=false",
  "SUPABASE_REALTIME_ENABLED=false",
  "SUPABASE_STORAGE_ENABLED=false",
  "",
].join("\n");

interface Fixture {
  readonly golden: string;
  readonly name: string;
  readonly config: string;
  readonly shellEnv?: Readonly<Record<string, string>>;
  readonly dotenv?: string;
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    golden: "no-overrides",
    name: "shadow container inputs for a linked ref with no overrides use the base config",
    config: BASE_CONFIG,
  },
  {
    golden: "matched-remote",
    name: "shadow container inputs apply a matched remote's port, schemas and auth settings",
    config: BASE_CONFIG + REMOTE_BLOCK,
  },
  {
    golden: "shell-env",
    name: "shadow container inputs follow shell env over base config",
    config: BASE_CONFIG,
    shellEnv: SHELL_ENV,
  },
  {
    golden: "project-dotenv",
    name: "shadow container inputs follow supabase/.env over base config",
    config: BASE_CONFIG,
    dotenv: DOTENV,
  },
  {
    golden: "matched-remote-with-project-id-env",
    name: "SUPABASE_PROJECT_ID beats a matched remote's project_id for the shadow container naming",
    config: BASE_CONFIG + REMOTE_BLOCK,
    shellEnv: { SUPABASE_PROJECT_ID: "shell-project-id" },
  },
  {
    golden: "matched-remote-with-shell-env",
    name: "shell env beats a matched remote in shadow container inputs while unset keys follow the remote",
    config: BASE_CONFIG + REMOTE_BLOCK,
    shellEnv: SHELL_ENV,
  },
];

const configEnvOnly = (env: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("SUPABASE_")));

const tempRoot = useTempWorkdir("container-inputs-golden-");

describe("local container inputs precedence goldens", () => {
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
          cliConfigValuesTestLayer,
          Layer.succeed(ConfigEnvPins, fixture.shellEnv ?? {}),
          mockRuntimeInfo({ platform: "linux" }),
          Layer.succeed(CliArgs, { args: ["db", "diff"] }),
          Layer.succeed(ExperimentalFlag, false),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
              ),
            ),
          ),
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
        const spawner = ChildProcessSpawner.make(() =>
          Effect.die("the container inputs prelude must not spawn a process"),
        );

        const inputs = yield* Effect.gen(function* () {
          return yield* buildLocalDbContainerInputs(
            spawner,
            workdir,
            Option.none(),
            "linux",
            false,
            TARGET_REF,
          );
        }).pipe(Effect.provide(layer));

        const { context, setup, ...rest } = inputs;
        const golden = {
          ...rest,
          appliedRemote: Option.getOrUndefined(context.snapshot.appliedRemote),
          projectEnvValues: configEnvOnly(context.projectEnvValues),
          projectId: context.projectId,
          setup: {
            ...setup,
            jwks: undefined,
            projectEnvValues: configEnvOnly(setup.projectEnvValues ?? {}),
          },
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
