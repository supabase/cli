import { Context, Data, Effect, FileSystem, Layer, Path, Ref, type Scope } from "effect";
import { FetchHttpClient } from "effect/http";

import { startReplayServer } from "../../../cli-e2e/src/server/replay-server.ts";
import { resetReplay } from "../../scripts/replay-control.ts";
import {
  makeTempHome,
  overrideStackPorts,
  requireCliSuccess,
  runDockerEffect,
  runSupabaseEffect,
} from "./cli.ts";

/** Where a recorded docs example runs. */
export type DocsExampleKind = "replay" | "local" | "docker";

type Substitutions = ReadonlyArray<readonly [string, string]>;

/** The setup a recorded docs example names in its `scenario`. */
interface DocsExampleScenario {
  readonly kind: DocsExampleKind;
  /** A hand-authored `docs-*` Management API fixture under `apps/cli-e2e/fixtures/scenarios`. */
  readonly api?: string;
  /** Runs `supabase init` in the project directory first. */
  readonly init?: boolean;
  /** Files written into the project directory, keyed by relative path. */
  readonly files?: Readonly<Record<string, string>>;
  /** Piped to the command's stdin, as the example's shell pipeline does. */
  readonly stdin?: string;
  /** docker: the stack state the example starts from. */
  readonly stack?: "running" | "stopped";
  /** docker: SQL statements run against the local database before the example. */
  readonly sql?: ReadonlyArray<string>;
  /** docker: a `[from, to]` edit to `supabase/config.toml`, reverted after the example. */
  readonly config?: readonly [string, string];
  /**
   * docker: undoes what the example changed: SQL to run, generated migrations to delete and
   * project paths to remove. The scenario's `files` are always removed.
   */
  readonly cleanup?: {
    readonly sql?: ReadonlyArray<string>;
    readonly migrations?: RegExp;
    readonly paths?: ReadonlyArray<string>;
  };
  /** docker: the example starts or stops the stack. */
  readonly changesStack?: boolean;
  /**
   * docker: `[docs text, run text]` pairs. The run text replaces the docs text in the argv and
   * the docs text replaces it in the output; `{dbPort}` is the stack's database port.
   */
  readonly rewrite?: Substitutions;
}

/** Where and how a recorded docs example runs, and the run-specific text its output must not keep. */
export interface DocsExampleRun {
  readonly cwd: string;
  readonly home: string;
  readonly env: Record<string, string>;
  readonly stdin?: string;
  /** `[run text, docs text]` replacements applied to the output before it is compared or recorded. */
  readonly substitutions: Substitutions;
  /** `[docs text, run text]` replacements applied to the example's argv. */
  readonly argv: Substitutions;
  /** Runs after the example. */
  readonly after: Effect.Effect<void, DocsExampleScenarioError>;
}

export class DocsExampleScenarioError extends Data.TaggedError("DocsExampleScenarioError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const ACCESS_TOKEN = `sbp_${"0".repeat(40)}`;

/** The project the replay fixtures mark as linked: `My Project`. */
const DOCS_LINKED_PROJECT_REF = "xkvpqmdrbtwnjzhcuaoe";

/** Every Docker run shows this project id, whatever id the run's stack uses. */
const DOCS_PROJECT_ID = "my-project";

/** Every run shows this project directory. */
const DOCS_PROJECT_DIR = "~/my-project";

const FIXTURES_DIR = new URL("../../../cli-e2e/fixtures", import.meta.url).pathname;

const SAML_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com/saml">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/saml/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>
`;

const SELF_HOSTED_DB: Substitutions = [
  ["user:pass@db.example.com:5432", "postgres:postgres@127.0.0.1:{dbPort}"],
  ["db.example.com:5432", "127.0.0.1:{dbPort}"],
];

const MY_TABLE_DRIFT = {
  sql: [
    "create table if not exists public.my_table (id bigint primary key generated always as identity, title text not null)",
  ],
  cleanup: {
    sql: [
      "drop table if exists public.my_table",
      "delete from supabase_migrations.schema_migrations where name in ('my_table', 'remote_schema')",
    ],
    migrations: /_(?:my_table|remote_schema)\.sql$/,
  },
};

const UNPUSH_EMPLOYEE_EMAIL = [
  "alter table public.employees drop column if exists email",
  "delete from supabase_migrations.schema_migrations where version = '20240102000000'",
];

const DECLARATIVE_SCHEMA_PATH = [
  '# declarative_schema_path = "./schemas"',
  'declarative_schema_path = "./schemas"',
] as const;

/** The stack project every docker scenario shares; examples run in it in declaration order. */
const STACK_FILES: Readonly<Record<string, string>> = {
  "supabase/migrations/20240101000000_create_employees.sql":
    "create table public.employees (\n  id bigint primary key generated always as identity,\n  name text not null\n);\n",
  "supabase/seed.sql":
    "insert into public.employees (name) values ('Ada Lovelace'), ('Alan Turing');\n",
  "supabase/tests/employees_test.sql":
    "begin;\nselect plan(1);\nselect has_table('public', 'employees', 'employees table exists');\nselect * from finish();\nrollback;\n",
};

/** The scenarios a `recorded` docs example can name. */
const DOCS_EXAMPLE_SCENARIOS = {
  "docs-projects-list": { kind: "replay", api: "docs-projects-list" },
  "docs-link": { kind: "replay", api: "docs-link", init: true },
  "docs-sso-info": { kind: "replay", api: "docs-sso-info" },
  "docs-sso-show": { kind: "replay", api: "docs-sso-show" },
  "docs-sso-remove": { kind: "replay", api: "docs-sso-remove" },
  "docs-sso-add": {
    kind: "replay",
    api: "docs-sso-add",
    files: { "metadata.xml": SAML_METADATA },
  },
  "docs-sso-update-domains": { kind: "replay", api: "docs-sso-update-domains" },
  "docs-sso-update-add-domains": { kind: "replay", api: "docs-sso-update-add-domains" },
  "docs-sso-update-remove-domains": { kind: "replay", api: "docs-sso-update-remove-domains" },
  "local-empty-dir": { kind: "local" },
  "local-project": { kind: "local", init: true },
  "local-project-stdin": {
    kind: "local",
    init: true,
    stdin: "create schema if not exists test;\n",
  },
  "docker-stack-stopped": { kind: "docker", stack: "stopped", changesStack: true },
  "docker-stack-running": { kind: "docker", stack: "running" },
  "docker-stack-stopping": { kind: "docker", stack: "running", changesStack: true },
  "docker-schema-drift": { kind: "docker", stack: "running", ...MY_TABLE_DRIFT },
  "docker-self-hosted": {
    kind: "docker",
    stack: "running",
    rewrite: SELF_HOSTED_DB,
    files: {
      "supabase/migrations/20240102000000_add_employee_email.sql":
        "alter table public.employees add column email text;\n",
    },
    sql: UNPUSH_EMPLOYEE_EMAIL,
    cleanup: {
      sql: UNPUSH_EMPLOYEE_EMAIL,
    },
  },
  "docker-declarative-missing": {
    kind: "docker",
    stack: "running",
    config: DECLARATIVE_SCHEMA_PATH,
    cleanup: { paths: ["supabase/schemas"] },
  },
  "docker-declarative-edited": {
    kind: "docker",
    stack: "running",
    config: DECLARATIVE_SCHEMA_PATH,
    files: {
      "supabase/schemas/public.sql":
        "create table public.employees (\n  id bigint primary key generated always as identity,\n  name text not null,\n  updated_at timestamptz not null default now()\n);\n",
    },
    cleanup: {
      sql: [
        "alter table public.employees drop column if exists updated_at",
        "delete from supabase_migrations.schema_migrations where name = 'add_updated_at'",
      ],
      migrations: /_add_updated_at\.sql$/,
      paths: ["supabase/schemas"],
    },
  },
} as const satisfies Record<string, DocsExampleScenario>;

/** Versions of the migration files the scenarios write, which a run never generates. */
export const FIXED_MIGRATION_VERSIONS: ReadonlySet<string> = new Set(
  [
    STACK_FILES,
    ...Object.values<DocsExampleScenario>(DOCS_EXAMPLE_SCENARIOS).map(({ files }) => files ?? {}),
  ]
    .flatMap((files) => Object.keys(files))
    .flatMap((file) => /^supabase\/migrations\/(\d{14})_/.exec(file)?.[1] ?? []),
);

export type DocsExampleScenarioName = keyof typeof DOCS_EXAMPLE_SCENARIOS;

export const isDocsExampleScenario = (name: string): name is DocsExampleScenarioName =>
  Object.hasOwn(DOCS_EXAMPLE_SCENARIOS, name);

export const scenarioKind = (name: DocsExampleScenarioName): DocsExampleKind =>
  DOCS_EXAMPLE_SCENARIOS[name].kind;

const scenarioOf = (name: DocsExampleScenarioName): DocsExampleScenario =>
  DOCS_EXAMPLE_SCENARIOS[name];

/** Replay fixtures named by a scenario that have no `interactions.json`. */
export const missingScenarioFixtures = Effect.fn("docsExamples.missingScenarioFixtures")(function* (
  names: ReadonlyArray<DocsExampleScenarioName>,
) {
  const fs = yield* FileSystem.FileSystem;
  const missing: Array<string> = [];
  for (const name of names) {
    const api = scenarioOf(name).api;
    if (
      api !== undefined &&
      !(yield* fs.exists(`${FIXTURES_DIR}/scenarios/${api}/interactions.json`))
    ) {
      missing.push(api);
    }
  }
  return missing;
});

const scenarioError = (message: string) => (cause: unknown) =>
  new DocsExampleScenarioError({ message, cause });

const writeFiles = Effect.fnUntraced(function* (
  dir: string,
  files: Readonly<Record<string, string>> | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relative, content] of Object.entries(files ?? {})) {
    const file = path.join(dir, relative);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  }
});

/** Runs a setup command in `cwd`, failing with its output when it exits non-zero. */
const runSetup = (
  argv: Array<string>,
  options: { readonly cwd: string; readonly home: string; readonly env?: Record<string, string> },
) =>
  runSupabaseEffect(argv, { ...options, exitTimeoutMs: 280_000 }).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => requireCliSuccess(result, `supabase ${argv.join(" ")}`),
        catch: scenarioError(`setup failed: supabase ${argv.join(" ")}`),
      }),
    ),
    Effect.mapError(scenarioError(`setup failed: supabase ${argv.join(" ")}`)),
  );

const makeProjectDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-docs-example-" });
  return { dir, realDir: yield* fs.realPath(dir) };
});

/**
 * Runs the CLI with `name`'s replay fixture loaded, as a logged-in user linked to `My Project`,
 * from an empty temp home and project directory.
 */
const replayRun = Effect.fnUntraced(function* (scenario: DocsExampleScenario) {
  const fs = yield* FileSystem.FileSystem;
  const server = yield* startReplayServer({
    fixturesDir: FIXTURES_DIR,
    record: false,
    stagingUrl: undefined,
  });
  yield* resetReplay(server.url, scenario.api).pipe(Effect.provide(FetchHttpClient.layer));
  const home = yield* makeTempHome;
  const project = yield* makeProjectDir;
  if (scenario.init === true) yield* runSetup(["init"], { cwd: project.dir, home: home.dir });
  yield* writeFiles(project.dir, scenario.files);
  const profile = `${home.dir}/docs-example-profile.yaml`;
  yield* fs.writeFileString(
    profile,
    [
      "name: docs-example",
      `api_url: "${server.url}"`,
      `dashboard_url: "${server.url}"`,
      "project_host: localhost",
      "",
    ].join("\n"),
  );
  const realHome = yield* fs.realPath(home.dir);
  const run: DocsExampleRun = {
    cwd: project.dir,
    home: home.dir,
    env: {
      SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN,
      SUPABASE_PROFILE: profile,
      SUPABASE_PROJECT_ID: DOCS_LINKED_PROJECT_REF,
    },
    ...(scenario.stdin === undefined ? {} : { stdin: scenario.stdin }),
    substitutions: [
      [server.url, "https://supabase.com"],
      [project.realDir, DOCS_PROJECT_DIR],
      [project.dir, DOCS_PROJECT_DIR],
      [realHome, "~/.supabase"],
      [home.dir, "~/.supabase"],
    ],
    argv: [],
    after: Effect.void,
  };
  return run;
});

/** Runs the CLI offline in a temp project directory, `supabase init`ed when the scenario asks. */
const localRun = Effect.fnUntraced(function* (scenario: DocsExampleScenario) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* makeTempHome;
  const project = yield* makeProjectDir;
  if (scenario.init === true) yield* runSetup(["init"], { cwd: project.dir, home: home.dir });
  yield* writeFiles(project.dir, scenario.files);
  const realHome = yield* fs.realPath(home.dir);
  const run: DocsExampleRun = {
    cwd: project.dir,
    home: home.dir,
    env: {},
    ...(scenario.stdin === undefined ? {} : { stdin: scenario.stdin }),
    substitutions: [
      [project.realDir, DOCS_PROJECT_DIR],
      [project.dir, DOCS_PROJECT_DIR],
      [realHome, "~/.supabase"],
      [home.dir, "~/.supabase"],
    ],
    argv: [],
    after: Effect.void,
  };
  return run;
});

/**
 * Runs a recorded example of the `replay` or `local` kind; the returned run's temp directories and
 * replay server live as long as the scope.
 */
export const prepareDocsExample = (
  name: DocsExampleScenarioName,
): Effect.Effect<
  DocsExampleRun,
  DocsExampleScenarioError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> => {
  const scenario = scenarioOf(name);
  const prepared = scenario.kind === "replay" ? replayRun(scenario) : localRun(scenario);
  return prepared.pipe(
    Effect.mapError((cause) =>
      cause instanceof DocsExampleScenarioError
        ? cause
        : new DocsExampleScenarioError({ message: `scenario "${name}" setup failed`, cause }),
    ),
  );
};

/** The local stack project every docker scenario shares, started and stopped on demand. */
export class DocsStack extends Context.Service<
  DocsStack,
  {
    readonly prepare: (
      name: DocsExampleScenarioName,
    ) => Effect.Effect<DocsExampleRun, DocsExampleScenarioError>;
  }
>()("docsExamples/DocsStack") {}

const STACK_PORT_LINE = /^\s*(?:port|smtp_port|pop3_port|inspector_port|shadow_port) = (\d+)$/;

/** `[run port, default port]` for every port `overrideStackPorts` reassigned. */
const portSubstitutions = (before: string, after: string): Substitutions => {
  const original = before.split("\n");
  return after.split("\n").flatMap((line, index) => {
    const moved = STACK_PORT_LINE.exec(line)?.[1];
    const initial = STACK_PORT_LINE.exec(original[index] ?? "")?.[1];
    return moved === undefined || initial === undefined || moved === initial
      ? []
      : [[`:${moved}`, `:${initial}`] as const];
  });
};

/**
 * One `supabase init`ed stack project on free ports with a fixed migration, seed and test, never
 * registered with the per-test stack cleanup; its scope stops the stack and removes its data.
 */
export const docsStackLayer = Layer.effect(
  DocsStack,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* makeTempHome;
    const project = yield* makeProjectDir;
    const runOptions = { cwd: project.dir, home: home.dir };
    yield* runSetup(["init"], runOptions);
    const configPath = path.join(project.dir, "supabase", "config.toml");
    const projectId = `docs-${path
      .basename(project.dir)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(-8)}`;
    const initialConfig = (yield* fs.readFileString(configPath)).replace(
      /^project_id = .*$/m,
      `project_id = "${projectId}"`,
    );
    yield* fs.writeFileString(configPath, initialConfig);
    yield* Effect.tryPromise({
      try: () => overrideStackPorts(project.dir),
      catch: scenarioError("failed to move the stack to free ports"),
    });
    const config = yield* fs.readFileString(configPath);
    const ports = portSubstitutions(initialConfig, config);
    const dbPort = ports.find(([, initial]) => initial === ":54322")?.[0].slice(1) ?? "54322";
    yield* writeFiles(project.dir, STACK_FILES);
    yield* Effect.addFinalizer(() =>
      runSetup(["stop", "--no-backup"], runOptions).pipe(Effect.orDie),
    );

    const running = yield* Ref.make(false);
    const stop = runSetup(["stop", "--no-backup"], runOptions).pipe(
      Effect.andThen(Ref.set(running, false)),
    );
    const ensureRunning = Effect.gen(function* () {
      if (yield* Ref.get(running)) return;
      yield* stop;
      yield* runSetup(["start"], runOptions);
      yield* Ref.set(running, true);
    });
    const query = (statements: ReadonlyArray<string>) =>
      Effect.forEach(statements, (sql) => runSetup(["db", "query", sql], runOptions), {
        discard: true,
      });
    const withDbPort = (pairs: Substitutions | undefined): Substitutions =>
      (pairs ?? []).map(([docs, run]) => [docs, run.replaceAll("{dbPort}", dbPort)] as const);
    const realHome = yield* fs.realPath(home.dir);
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const prepare = (name: DocsExampleScenarioName) =>
      Effect.gen(function* () {
        const scenario = scenarioOf(name);
        if (scenario.stack === "stopped") yield* stop;
        else yield* ensureRunning;
        const originalConfig = yield* fs.readFileString(configPath);
        if (scenario.config !== undefined) {
          yield* fs.writeFileString(configPath, originalConfig.replace(...scenario.config));
        }
        yield* writeFiles(project.dir, scenario.files);
        if (scenario.sql !== undefined) yield* query(scenario.sql);
        const rewrite = withDbPort(scenario.rewrite);
        const cleanup = scenario.cleanup;
        const after = Effect.gen(function* () {
          if (scenario.changesStack === true) yield* Ref.set(running, false);
          yield* fs.writeFileString(configPath, originalConfig);
          const removed = [...Object.keys(scenario.files ?? {}), ...(cleanup?.paths ?? [])];
          for (const relative of removed) {
            yield* fs.remove(path.join(project.dir, relative), { recursive: true, force: true });
          }
          if (cleanup?.sql !== undefined) yield* query(cleanup.sql);
          const migrations = cleanup?.migrations;
          if (migrations === undefined) return;
          const migrationsDir = path.join(project.dir, "supabase", "migrations");
          for (const file of yield* fs.readDirectory(migrationsDir)) {
            if (migrations.test(file)) yield* fs.remove(path.join(migrationsDir, file));
          }
        }).pipe(
          Effect.mapError(scenarioError(`scenario "${name}" cleanup failed`)),
          Effect.provide(services),
        );
        const run: DocsExampleRun = {
          cwd: project.dir,
          home: home.dir,
          env: {},
          substitutions: [
            ...rewrite.map(([docs, run]) => [run, docs] as const),
            ...ports,
            [projectId, DOCS_PROJECT_ID],
            [project.realDir, DOCS_PROJECT_DIR],
            [project.dir, DOCS_PROJECT_DIR],
            [realHome, "~/.supabase"],
            [home.dir, "~/.supabase"],
          ],
          argv: rewrite,
          after,
        };
        return run;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof DocsExampleScenarioError
            ? cause
            : new DocsExampleScenarioError({ message: `scenario "${name}" setup failed`, cause }),
        ),
        Effect.provide(services),
      );
    return { prepare };
  }).pipe(Effect.mapError(scenarioError("docs example stack setup failed"))),
);

/** Whether a Docker daemon answers, so the docker examples can run. */
export const dockerAvailable = runDockerEffect(["info"]).pipe(
  Effect.as(true),
  Effect.orElseSucceed(() => false),
  Effect.scoped,
);
