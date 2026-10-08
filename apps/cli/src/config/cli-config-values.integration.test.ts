import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import { withEnvVar } from "../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { createStackConfigProject } from "../../tests/helpers/stack-config.ts";
import { loadStackConfig } from "../command-internal/stack-config.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { cliConfigProviderLayer } from "../shared/config/cli-config-provider.layer.ts";
import { CliConfigFlagInputs } from "./cli-config-flags.ts";
import { CliConfigKeys } from "./cli-config-keys.ts";
import { cliConfigValuesLayer } from "./cli-config-values.layer.ts";
import { CliConfigValues } from "./cli-config-values.service.ts";

const LINKED = "abcdefghijklmnopqrst";
const OTHER = "tsrqponmlkjihgfedcba";

const flagInput = (path: string, flag: string, value: unknown) =>
  [path, { path, flag, value }] as const;

const makeLayer = (flags: ReadonlyArray<ReturnType<typeof flagInput>> = []) => {
  const output = mockOutput();
  const layer = cliConfigValuesLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        BunServices.layer,
        output.layer,
        Layer.succeed(CliConfigFlagInputs, new Map(flags)),
      ),
    ),
  );
  return { layer, output };
};

const withShell = <A, E, R>(
  shell: Readonly<Record<string, string | undefined>>,
  body: Effect.Effect<A, E, R>,
) =>
  Object.entries(shell).reduce(
    (effect, [name, value]) => withEnvVar(name, value, effect),
    body.pipe(Effect.provide(cliConfigProviderLayer)),
  );

const link = (root: string, ref: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(root, "supabase", ".temp"), { recursive: true });
    yield* fs.writeFileString(path.join(root, "supabase", ".temp", "project-ref"), ref);
  });

const project = (config: string, options: { readonly supabaseEnv?: string } = {}) =>
  createStackConfigProject(config, { prefix: "supabase-cli-config-values-", ...options });

describe("CliConfigValues credential scoping", () => {
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly linkedTo: string | undefined;
    readonly target: Option.Option<string>;
    readonly adHoc?: boolean;
    readonly withheld: boolean;
  }> = [
    {
      name: "a target that matches the linked project",
      linkedTo: LINKED,
      target: Option.some(LINKED),
      withheld: false,
    },
    {
      name: "a target other than the linked project",
      linkedTo: LINKED,
      target: Option.some(OTHER),
      withheld: true,
    },
    {
      name: "a target in an unlinked workdir",
      linkedTo: undefined,
      target: Option.some(OTHER),
      withheld: false,
    },
    {
      name: "an ad hoc target in an unlinked workdir",
      linkedTo: undefined,
      target: Option.some(OTHER),
      adHoc: true,
      withheld: true,
    },
    {
      name: "an ad hoc target equal to the linked project",
      linkedTo: LINKED,
      target: Option.some(LINKED),
      adHoc: true,
      withheld: true,
    },
    { name: "no target", linkedTo: LINKED, target: Option.none(), withheld: false },
  ];

  for (const scenario of scenarios) {
    it.live(
      `${scenario.withheld ? "withholds" : "offers"} SUPABASE_DB_PASSWORD for ${scenario.name}`,
      () =>
        Effect.gen(function* () {
          const root = yield* project('project_id = "scoped"\n', {
            supabaseEnv: "SUPABASE_DB_PASSWORD=from-file\n",
          });
          if (scenario.linkedTo !== undefined) yield* link(root, scenario.linkedTo);
          const { layer } = makeLayer();

          const snapshot = yield* Effect.gen(function* () {
            const values = yield* CliConfigValues;
            return yield* values.load({
              workdir: root,
              projectRef: scenario.target,
              ...(scenario.adHoc === undefined ? {} : { adHocProjectRef: scenario.adHoc }),
            });
          }).pipe(Effect.provide(layer));
          const password = yield* snapshot.get(CliConfigKeys.linkedDb.password);

          if (scenario.withheld) {
            expect(password.value).toEqual(Option.none());
            expect(snapshot.sources.withheldEnv).toEqual([
              {
                path: "linkedDb.password",
                envName: "SUPABASE_DB_PASSWORD",
                tier: "shell",
                reason: scenario.adHoc === true ? "adHocProjectRef" : "foreignProjectRef",
                targetRef: Option.getOrElse(scenario.target, () => ""),
                linkedRef: scenario.adHoc === true ? Option.none() : Option.some(LINKED),
              },
            ]);
          } else {
            expect(password.value).toEqual(Option.some("from-shell"));
            expect(password.origin).toMatchObject({ tier: "shell" });
            expect(snapshot.sources.withheldEnv).toEqual([]);
          }
        }).pipe(
          Effect.provide(BunServices.layer),
          (effect) => withShell({ SUPABASE_DB_PASSWORD: "from-shell" }, effect),
          Effect.scoped,
        ),
    );
  }

  it.live("reports a withheld project .env password when the shell does not set one", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "scoped"\n', {
        supabaseEnv: "SUPABASE_DB_PASSWORD=from-file\n",
      });
      yield* link(root, LINKED);
      const { layer } = makeLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(OTHER) }),
      ).pipe(Effect.provide(layer));

      expect(snapshot.sources.withheldEnv).toMatchObject([
        { envName: "SUPABASE_DB_PASSWORD", tier: "projectEnv" },
      ]);
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_DB_PASSWORD: undefined }, effect),
      Effect.scoped,
    ),
  );

  it.live("keeps an explicit --password on a foreign project", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "scoped"\n');
      yield* link(root, LINKED);
      const { layer } = makeLayer([flagInput("linkedDb.password", "password", "explicit")]);

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(OTHER) }),
      ).pipe(Effect.provide(layer));
      const password = yield* snapshot.get(CliConfigKeys.linkedDb.password);

      expect(password).toMatchObject({ value: Option.some("explicit"), origin: { tier: "flag" } });
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_DB_PASSWORD: "from-shell" }, effect),
      Effect.scoped,
    ),
  );

  it.live("keeps config secrets env-sourced on a foreign project", () =>
    Effect.gen(function* () {
      const root = yield* project(
        'project_id = "scoped"\n[auth.captcha]\nenabled = true\nprovider = "hcaptcha"\nsecret = "from-config"\n',
      );
      yield* link(root, LINKED);
      const { layer } = makeLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(OTHER) }),
      ).pipe(Effect.provide(layer));
      const secret = yield* snapshot.get(CliConfigKeys.auth.captcha.secret);

      expect(secret).toMatchObject({
        value: Option.some("from-shell"),
        origin: { tier: "shell", envName: "SUPABASE_AUTH_CAPTCHA_SECRET" },
      });
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_AUTH_CAPTCHA_SECRET: "from-shell" }, effect),
      Effect.scoped,
    ),
  );
});

describe("CliConfigValues remotes", () => {
  const remoteConfig = `project_id = "base"
[db]
port = 54399

[remotes.staging]
project_id = "${LINKED}"

[remotes.staging.db]
major_version = 15
`;

  it.live("merges the matching remote and keeps its implicit seed default in the config tier", () =>
    Effect.gen(function* () {
      const root = yield* project(remoteConfig);
      const { layer } = makeLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(LINKED) }),
      ).pipe(Effect.provide(layer));

      expect(snapshot.appliedRemote).toEqual(Option.some("staging"));
      expect((yield* snapshot.get(CliConfigKeys.db.majorVersion)).origin).toMatchObject({
        tier: "config",
        remote: "staging",
        origin: { source: "remote" },
      });
      expect(yield* snapshot.get(CliConfigKeys.db.seed.enabled)).toMatchObject({
        value: false,
        origin: { tier: "config", remote: "staging" },
      });
      expect((yield* snapshot.get(CliConfigKeys.db.port)).origin).toMatchObject({
        tier: "config",
        origin: { source: "local" },
      });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("lets env and flags beat the matched remote, including its seed default", () =>
    Effect.gen(function* () {
      const root = yield* project(remoteConfig);
      const { layer } = makeLayer([flagInput("db.seed.enabled", "include-seed", true)]);

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(LINKED) }),
      ).pipe(Effect.provide(layer));

      expect(yield* snapshot.get(CliConfigKeys.db.majorVersion)).toMatchObject({
        value: 17,
        origin: { tier: "shell" },
      });
      expect(yield* snapshot.get(CliConfigKeys.db.seed.enabled)).toMatchObject({
        value: true,
        origin: { tier: "flag", flag: "include-seed" },
      });
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_DB_MAJOR_VERSION: "17" }, effect),
      Effect.scoped,
    ),
  );

  it.live("selects the remote named by SUPABASE_REMOTES_<NAME>_PROJECT_ID", () =>
    Effect.gen(function* () {
      const root = yield* project(remoteConfig);
      const { layer } = makeLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(OTHER) }),
      ).pipe(Effect.provide(layer));

      expect(snapshot.appliedRemote).toEqual(Option.some("staging"));
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_REMOTES_STAGING_PROJECT_ID: OTHER }, effect),
      Effect.scoped,
    ),
  );

  it.live("applies no remote when the ref matches none", () =>
    Effect.gen(function* () {
      const root = yield* project(remoteConfig);
      const { layer } = makeLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.some(OTHER) }),
      ).pipe(Effect.provide(layer));

      expect(snapshot.appliedRemote).toEqual(Option.none());
      expect((yield* snapshot.get(CliConfigKeys.db.seed.enabled)).origin).toEqual({
        tier: "default",
      });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("fails the load on duplicate or malformed remote project ids", () =>
    Effect.gen(function* () {
      const duplicate = yield* project(
        `[remotes.a]\nproject_id = "${LINKED}"\n[remotes.b]\nproject_id = "${LINKED}"\n`,
      );
      const malformed = yield* project('[remotes.a]\nproject_id = "short"\n');
      const { layer } = makeLayer();
      const load = (root: string) =>
        CliConfigValues.use((values) =>
          values.load({ workdir: root, projectRef: Option.none() }),
        ).pipe(Effect.flip, Effect.provide(layer));

      expect((yield* load(duplicate)).message).toBe(
        "duplicate project_id for [remotes.b] and [remotes.a]",
      );
      expect((yield* load(malformed)).message).toBe(
        "Invalid config for remotes.a.project_id. Must be like: abcdefghijklmnopqrst",
      );
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );
});

describe("CliConfigValues snapshots", () => {
  it.live("memoises a load per target and drops the memo after a write", () =>
    Effect.gen(function* () {
      const root = yield* project("[db]\nport = 54399\n");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { layer } = makeLayer();

      yield* Effect.gen(function* () {
        const values = yield* CliConfigValues;
        const target = { workdir: root, projectRef: Option.none<string>() };
        const first = yield* values.load(target);
        const again = yield* values.load(target);
        const other = yield* values.load({ ...target, projectRef: Option.some(LINKED) });

        expect(again).toBe(first);
        expect(other).not.toBe(first);

        yield* values.writeThrough(
          fs.writeFileString(path.join(root, "supabase", "config.toml"), "[db]\nport = 54400\n"),
        );
        const reloaded = yield* values.load(target);

        expect(reloaded).not.toBe(first);
        expect((yield* reloaded.get(CliConfigKeys.db.port)).value).toBe(54400);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("warns once on stderr when a deprecated alias supplies the value", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "alias"\n');
      const { layer, output } = makeLayer();

      yield* Effect.gen(function* () {
        const values = yield* CliConfigValues;
        const snapshot = yield* values.load({ workdir: root, projectRef: Option.none() });
        const first = yield* snapshot.get(CliConfigKeys.experimental.pgdelta.enabled);
        yield* snapshot.get(CliConfigKeys.experimental.pgdelta.enabled);

        expect(first.value).toBe(true);
      }).pipe(Effect.provide(layer));

      expect(output.stderrText).toBe(
        "WARN: SUPABASE_EXPERIMENTAL_PG_DELTA is deprecated. Please use SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED instead.\n",
      );
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_EXPERIMENTAL_PG_DELTA: "true" }, effect),
      Effect.scoped,
    ),
  );

  it.live("fails a key read when the winning value does not decode", () =>
    Effect.gen(function* () {
      const root = yield* project('project_id = "bad"\n');
      const { layer } = makeLayer();

      const exit = yield* CliConfigValues.use((values) =>
        Effect.flatMap(values.load({ workdir: root, projectRef: Option.none() }), (snapshot) =>
          snapshot.get(CliConfigKeys.api.port),
        ),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain(
        'Invalid config for api.port: cannot parse "not-a-port" as a port',
      );
    }).pipe(
      Effect.provide(BunServices.layer),
      (effect) => withShell({ SUPABASE_API_PORT: "not-a-port" }, effect),
      Effect.scoped,
    ),
  );
});

describe("CliConfigValues.materialize", () => {
  const richConfig = `project_id = "rich"

[api]
port = 54321
schemas = ["public"]
max_rows = 500

[db]
port = 54322
major_version = 15
health_timeout = "3m"

[db.pooler]
enabled = true
port = 54329

[db.settings]
max_connections = 50

[auth]
enable_signup = true
site_url = "http://localhost:3000"
jwt_expiry = 3600
minimum_password_length = 8

[auth.email.smtp]
host = "smtp.example.com"
port = 587
user = "mailer"
pass = "mail-pass"
admin_email = "admin@example.com"

[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "captcha-secret"

[auth.mfa.totp]
enroll_enabled = false

[storage]
file_size_limit = "50MiB"

[studio]
port = 54323

[realtime]
ip_version = "IPv4"

[edge_runtime]
policy = "per_worker"
`;

  const overrides = [
    "SUPABASE_API_PORT=54421",
    "SUPABASE_API_SCHEMAS=public,extra",
    "SUPABASE_API_MAX_ROWS=0x20",
    "SUPABASE_DB_PORT=54422",
    "SUPABASE_DB_MAJOR_VERSION=17",
    "SUPABASE_DB_HEALTH_TIMEOUT=5m",
    "SUPABASE_DB_POOLER_ENABLED=false",
    "SUPABASE_DB_SETTINGS_MAX_CONNECTIONS=100",
    "SUPABASE_AUTH_ENABLE_SIGNUP=false",
    "SUPABASE_AUTH_SITE_URL=http://example.test",
    "SUPABASE_AUTH_JWT_EXPIRY=7200",
    "SUPABASE_AUTH_EMAIL_SMTP_HOST=smtp.override.test",
    "SUPABASE_AUTH_EMAIL_SMTP_PASS=override-pass",
    "SUPABASE_AUTH_CAPTCHA_PROVIDER=turnstile",
    "SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED=true",
    "SUPABASE_STORAGE_FILE_SIZE_LIMIT=100MiB",
    "SUPABASE_STUDIO_PORT=54523",
    "SUPABASE_REALTIME_IP_VERSION=IPv6",
    "SUPABASE_EDGE_RUNTIME_POLICY=oneshot",
  ].join("\n");

  it.live("agrees with the stack config overlay for the keys the overlay covers", () =>
    Effect.gen(function* () {
      const root = yield* project(richConfig, { supabaseEnv: `${overrides}\n` });
      const { layer } = makeLayer();

      const overlay = yield* loadStackConfig(root).pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
      );
      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer));
      const { config, originAt } = yield* snapshot.materialize;

      expect(config.api).toEqual(overlay.source.api);
      expect(config.db).toEqual(overlay.source.db);
      expect(config.studio).toEqual(overlay.source.studio);
      expect(config.realtime).toEqual(overlay.source.realtime);
      expect(config.edge_runtime).toEqual(overlay.source.edge_runtime);
      expect(config.storage).toEqual(overlay.source.storage);
      const hookEnabled = (hooks: typeof config.auth.hook) =>
        Object.fromEntries(Object.entries(hooks).map(([name, hook]) => [name, hook.enabled]));
      expect({ ...config.auth, hook: hookEnabled(config.auth.hook) }).toEqual({
        ...overlay.source.auth,
        hook: hookEnabled(overlay.source.auth.hook),
      });
      expect({
        port: config.api.port,
        schemas: config.api.schemas,
        maxRows: config.api.max_rows,
        majorVersion: config.db.major_version,
        poolerEnabled: config.db.pooler.enabled,
        maxConnections: config.db.settings?.max_connections,
        enableSignup: config.auth.enable_signup,
        smtpHost: config.auth.email.smtp?.host,
        captchaProvider: config.auth.captcha?.provider,
        totpEnroll: config.auth.mfa.totp.enroll_enabled,
        policy: config.edge_runtime.policy,
      }).toEqual({
        port: 54421,
        schemas: ["public", "extra"],
        maxRows: 32,
        majorVersion: 17,
        poolerEnabled: false,
        maxConnections: 100,
        enableSignup: false,
        smtpHost: "smtp.override.test",
        captchaProvider: "turnstile",
        totpEnroll: true,
        policy: "oneshot",
      });
      expect(originAt("api.port")).toMatchObject({
        tier: "projectEnv",
        envName: "SUPABASE_API_PORT",
      });
      expect(originAt("api.max_rows")).toMatchObject({ tier: "projectEnv" });
      expect(originAt("auth.email.smtp.port")).toMatchObject({ tier: "config" });
      expect(originAt("db.password")).toEqual({ tier: "default" });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );

  it.live("decodes defaults when the workdir has no config file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-cli-config-empty-" });
      const { layer } = makeLayer();

      const snapshot = yield* CliConfigValues.use((values) =>
        values.load({ workdir: root, projectRef: Option.none() }),
      ).pipe(Effect.provide(layer));
      const { config, originAt } = yield* snapshot.materialize;

      expect(snapshot.rawDocument).toEqual(Option.none());
      expect(config.db.port).toBe(54322);
      expect(originAt("db.port")).toEqual({ tier: "default" });
    }).pipe(Effect.provide(BunServices.layer), (effect) => withShell({}, effect), Effect.scoped),
  );
});
