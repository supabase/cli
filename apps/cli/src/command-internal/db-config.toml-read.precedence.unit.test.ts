import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Path, Result } from "effect";

import { ConfigEnvPins } from "../../tests/helpers/config-env-pins.ts";
import { goldenJson, useShellEnvPin } from "../../tests/helpers/config-goldens.ts";
import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { cliConfigValuesTestLayer } from "../../tests/helpers/config-snapshot-layer.ts";
import { checkDbToml } from "./db-config.toml-read.ts";

const TARGET_REF = "abcdefghijklmnopqrst";
const OTHER_REF = "zyxwvutsrqponmlkjihg";
const GOLDEN_DIR = "./testdata/config-precedence/db-toml";

const BASE_CONFIG = `project_id = "golden-base"

[api]
schemas = ["public", "base_api"]

[db]
port = 55001
shadow_port = 55002

[db.migrations]
enabled = true
schema_paths = ["./schemas/*.sql"]

[db.seed]
enabled = true
sql_paths = ["./seeds/*.sql"]

[auth]
enabled = true

[storage]
enabled = true

[realtime]
enabled = true

[experimental.pgdelta]
enabled = false
declarative_schema_path = "base-declarative"
`;

const remoteBlock = (projectId: string) => `
[remotes.prod]
project_id = "${projectId}"

[remotes.prod.db.migrations]
enabled = false

[remotes.prod.auth]
enabled = false

[remotes.prod.experimental.pgdelta]
declarative_schema_path = "remote-declarative"
`;

const SHELL_OVERRIDES = {
  SUPABASE_DB_MIGRATIONS_ENABLED: "false",
  SUPABASE_DB_PORT: "56001",
  SUPABASE_API_SCHEMAS: "public,shell_api",
  SUPABASE_DB_SEED_ENABLED: "false",
};

const DOTENV_OVERRIDES = [
  "SUPABASE_DB_MIGRATIONS_ENABLED=false",
  "SUPABASE_DB_PORT=57001",
  "SUPABASE_API_SCHEMAS=public,dotenv_api",
  "SUPABASE_DB_SEED_ENABLED=false",
  "",
].join("\n");

const CONFLICTING_SHELL = {
  SUPABASE_DB_MIGRATIONS_ENABLED: "true",
  SUPABASE_AUTH_ENABLED: "true",
  SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH: "shell-declarative",
  SUPABASE_DB_SEED_ENABLED: "true",
  SUPABASE_DB_PORT: "56001",
  SUPABASE_API_SCHEMAS: "public,shell_api",
};

interface Fixture {
  readonly golden: string;
  readonly name: string;
  readonly config: string;
  readonly shellEnv?: Readonly<Record<string, string>>;
  readonly dotenv?: string;
  readonly ref?: string;
  readonly expectedProjectId?: string;
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    golden: "a-base-only",
    name: "base config with no env and no remote resolves its own values",
    config: BASE_CONFIG,
    ref: TARGET_REF,
  },
  {
    golden: "b-matched-remote",
    name: "matched remote overrides migrations, auth and pgdelta and defaults seeding off",
    config: BASE_CONFIG + remoteBlock(TARGET_REF),
    ref: TARGET_REF,
  },
  {
    golden: "b2-remote-block-without-ref",
    name: "a remote block is ignored when no target ref is supplied",
    config: BASE_CONFIG + remoteBlock(TARGET_REF),
  },
  {
    golden: "c-shell-env",
    name: "shell env overrides base config for migrations, port, api schemas and seed",
    config: BASE_CONFIG,
    shellEnv: SHELL_OVERRIDES,
    ref: TARGET_REF,
  },
  {
    golden: "d-project-dotenv",
    name: "supabase/.env overrides base config for migrations, port, api schemas and seed",
    config: BASE_CONFIG,
    dotenv: DOTENV_OVERRIDES,
    ref: TARGET_REF,
  },
  {
    golden: "d2-shell-beats-dotenv",
    name: "shell env beats supabase/.env for the same key",
    config: BASE_CONFIG,
    shellEnv: SHELL_OVERRIDES,
    dotenv: DOTENV_OVERRIDES,
    ref: TARGET_REF,
  },
  {
    golden: "e-remote-beats-shell",
    name: "shell env beats a matched remote for db.migrations.enabled, auth.enabled, pgdelta path and seed",
    config: BASE_CONFIG + remoteBlock(TARGET_REF),
    shellEnv: CONFLICTING_SHELL,
    ref: TARGET_REF,
  },
  {
    golden: "e2-remote-beats-dotenv",
    name: "supabase/.env beats a matched remote for db.migrations.enabled and seed",
    config: BASE_CONFIG + remoteBlock(TARGET_REF),
    dotenv: DOTENV_OVERRIDES,
    ref: TARGET_REF,
  },
  {
    golden: "f-remote-matched-by-env-project-id",
    name: "SUPABASE_REMOTES_PROD_PROJECT_ID selects the remote block for the target ref",
    config: BASE_CONFIG + remoteBlock(OTHER_REF),
    shellEnv: { SUPABASE_REMOTES_PROD_PROJECT_ID: TARGET_REF },
    ref: TARGET_REF,
  },
  {
    golden: "f2-remote-env-match-project-id-is-block-literal",
    name: "remote matched via SUPABASE_REMOTES_PROD_PROJECT_ID yields projectId equal to the block's TOML literal, not the target ref",
    config: BASE_CONFIG + remoteBlock(OTHER_REF),
    shellEnv: { SUPABASE_REMOTES_PROD_PROJECT_ID: TARGET_REF },
    ref: TARGET_REF,
    expectedProjectId: OTHER_REF,
  },
  {
    golden: "g-captcha-secret-from-env-only",
    name: "captcha enabled in TOML passes validation with the secret only in SUPABASE_AUTH_CAPTCHA_SECRET",
    config: `${BASE_CONFIG}
[auth.captcha]
enabled = true
provider = "hcaptcha"
`,
    shellEnv: { SUPABASE_AUTH_CAPTCHA_SECRET: "fake-captcha-secret" },
    ref: TARGET_REF,
  },
  {
    golden: "h-storage-realtime-env-disable",
    name: "SUPABASE_STORAGE_ENABLED and SUPABASE_REALTIME_ENABLED disable the baseline storage and realtime flags",
    config: BASE_CONFIG,
    shellEnv: { SUPABASE_STORAGE_ENABLED: "false", SUPABASE_REALTIME_ENABLED: "false" },
    ref: TARGET_REF,
  },
  {
    golden: "i-project-id-env-with-matched-remote",
    name: "SUPABASE_PROJECT_ID beats a matched remote project_id",
    config: BASE_CONFIG + remoteBlock(TARGET_REF),
    shellEnv: { SUPABASE_PROJECT_ID: "shell-project-id" },
    ref: TARGET_REF,
  },
  {
    golden: "i2-project-id-env-without-remote",
    name: "SUPABASE_PROJECT_ID overrides the base project_id when no remote matches",
    config: BASE_CONFIG,
    shellEnv: { SUPABASE_PROJECT_ID: "shell-project-id" },
    ref: TARGET_REF,
  },
];

const tempRoot = useTempWorkdir("db-toml-golden-");

describe("db toml reader precedence goldens", () => {
  const pinShellEnv = useShellEnvPin();

  for (const fixture of FIXTURES) {
    it.effect(fixture.name, (ctx) =>
      Effect.gen(function* () {
        const workdir = tempRoot.current;
        const shell = fixture.shellEnv ?? {};
        mkdirSync(join(workdir, "supabase"), { recursive: true });
        writeFileSync(join(workdir, "supabase", "config.toml"), fixture.config);
        if (fixture.dotenv !== undefined) {
          writeFileSync(join(workdir, "supabase", ".env"), fixture.dotenv);
        }
        pinShellEnv(shell);

        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outcome = yield* checkDbToml(fs, path, workdir, fixture.ref).pipe(
          Effect.provide(cliConfigValuesTestLayer),
          Effect.provideService(ConfigEnvPins, shell),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord(shell, { preserveEmptyStrings: true }),
          ),
          Effect.result,
        );

        const snapshot = Result.isSuccess(outcome)
          ? { ok: outcome.success }
          : { error: { tag: outcome.failure._tag, message: outcome.failure.message } };
        if (fixture.expectedProjectId !== undefined) {
          ctx
            .expect(Result.isSuccess(outcome) ? outcome.success.projectId : undefined)
            .toBe(fixture.expectedProjectId);
        }
        yield* Effect.promise(() =>
          ctx
            .expect(goldenJson(snapshot, { [workdir]: "<WORKDIR>" }))
            .toMatchFileSnapshot(`${GOLDEN_DIR}/${fixture.golden}.json`),
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );
  }
});
