import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Stream,
} from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import {
  VALID_TOKEN,
  withConfigEnv,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { cliConfigValuesTestLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  AgentFlag,
  DnsResolverFlag,
  OutputFlag,
  YesFlag,
} from "../../../command-internal/global-flags.ts";
import { Random } from "../../../shared/runtime/random.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { AiTool } from "../../../shared/telemetry/ai-tool.service.ts";
import { CommandCredentials } from "../../../auth/command-credentials.service.ts";
import { validateAccessToken } from "../../../auth/access-token.ts";
import {
  ProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/project-ref.service.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { ProjectRefReadError } from "../../../shared/config/temp-paths.ts";
import { TelemetryOutputFormat } from "../../../telemetry/telemetry-output-format.service.ts";
import { DbConfigParseUrlError } from "../../../command-internal/db-config.errors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { HostedMutationConsentRequiredError } from "../../../command-internal/hosted-consent/hosted-consent.errors.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import {
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
} from "../../../command-internal/target/target.errors.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import {
  DbConnection,
  type PgConnInput,
  type QueryResult,
} from "../../../command-internal/db-connection.service.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  primaryPoolerConfigs,
  realDbConfigResolver,
  realLinkedProjectCache,
  stubManagementApi,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { RLS_CHECK_SQL } from "./query.advisory.ts";
import type { DbQueryFlags } from "./query.command.ts";
import { DbQueryReadOnlyStatementError } from "./query.errors.ts";
import { dbQuery } from "./query.handler.ts";

const LOCAL_CONN: PgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};
const REF = "abcdefghijklmnopqrst";
const BOUNDARY = "00112233445566778899aabbccddeeff";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const failMessage = (exit: Exit.Exit<unknown, { readonly message: string }>): string | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error.message : undefined;

function mockResolver(isLocal: boolean | undefined, resolveFails = false) {
  return Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) =>
      resolveFails
        ? Effect.fail(
            new DbConfigParseUrlError({
              message: "failed to parse connection string: invalid dsn",
            }),
          )
        : Effect.succeed({
            conn: LOCAL_CONN,
            isLocal: isLocal ?? input.target.kind === "local",
            ref: input.target.kind === "linked" ? Option.some(input.target.ref) : Option.none(),
            target: input.target,
          } satisfies ResolvedDbConnection),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
}

const WRITE_STATEMENT = /\b(insert|update|delete|create|drop|alter)\b/iu;
const READ_ONLY_LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'";

function mockDbConnection(opts: {
  result?: QueryResult;
  rlsTables?: ReadonlyArray<string>;
  rlsFails?: boolean;
  queryFails?: boolean;
}) {
  const statements: Array<string> = [];
  let connects = 0;
  let inReadOnly = false;
  const layer = Layer.succeed(DbConnection, {
    connect: () =>
      Effect.succeed({
        exec: () => Effect.void,
        execBatch: () => Effect.void,
        query: () => Effect.succeed([]),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: (sql: string) =>
          Effect.suspend(() => {
            if (sql === RLS_CHECK_SQL) {
              return opts.rlsFails === true
                ? Effect.fail(new DbExecError({ message: "advisory failed" }))
                : Effect.succeed({
                    fields: ["format"],
                    rows: (opts.rlsTables ?? []).map((table) => [table]),
                    commandTag: `SELECT ${(opts.rlsTables ?? []).length}`,
                  });
            }
            statements.push(sql);
            if (sql === "BEGIN READ ONLY") {
              inReadOnly = true;
              return Effect.succeed({ fields: [], rows: [], commandTag: "BEGIN" });
            }
            if (sql === "ROLLBACK") {
              inReadOnly = false;
              return Effect.succeed({ fields: [], rows: [], commandTag: "ROLLBACK" });
            }
            if (inReadOnly && WRITE_STATEMENT.test(sql)) {
              return Effect.fail(
                new DbExecError({ message: "cannot execute INSERT in a read-only transaction" }),
              );
            }
            return opts.queryFails === true
              ? Effect.fail(new DbExecError({ message: "failed to execute query: boom" }))
              : Effect.succeed(opts.result ?? { fields: [], rows: [], commandTag: "CREATE TABLE" });
          }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            connects += 1;
          }),
        ),
      ),
  });
  return {
    layer,
    get statements() {
      return statements;
    },
    get connects() {
      return connects;
    },
  };
}

function mockTelemetryOutputFormat() {
  let format: string | undefined;
  return {
    layer: Layer.succeed(TelemetryOutputFormat, {
      set: (f: string) =>
        Effect.sync(() => {
          format = f;
        }),
      get: Effect.sync(() => (format === undefined ? Option.none() : Option.some(format))),
    }),
    get format() {
      return format;
    },
  };
}

function mockProjectRef(unlinked = false, refReadFails = false) {
  // An explicit `--project-ref` wins first, then ProjectRefNotLinkedError when unlinked, or a
  // read error for an unreadable ref file.
  const resolveRef = (flagValue: Option.Option<string>) =>
    Option.isSome(flagValue) && flagValue.value.length > 0
      ? Effect.succeed({ ref: flagValue.value, source: "flag" as const, matchesLinkedRef: false })
      : refReadFails
        ? Effect.fail(
            new ProjectRefReadError({
              message: "failed to load project ref: permission denied",
            }),
          )
        : unlinked
          ? Effect.fail(new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }))
          : Effect.succeed({ ref: REF, source: "file" as const, matchesLinkedRef: true });
  return Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.die("resolve is not used by this test"),
    resolveForLink: () => Effect.succeed(REF),
    resolveRef,
    resolveOptional: () => Effect.succeed(unlinked ? Option.none() : Option.some(REF)),
    promptProjectRef: () => Effect.succeed(REF),
  });
}

function mockStdin(opts: { isTTY?: boolean; piped?: string }) {
  return Layer.succeed(Stdin, {
    isTTY: opts.isTTY ?? true,
    readPipedBytes: Effect.succeed(
      opts.piped === undefined ? Option.none() : Option.some(new TextEncoder().encode(opts.piped)),
    ),
    pipedBytesStream:
      opts.piped === undefined
        ? Stream.empty
        : Stream.fromIterable([new TextEncoder().encode(opts.piped)]),
    readPipedText: Effect.succeed(
      opts.piped === undefined || opts.piped.trim() === ""
        ? Option.none()
        : Option.some(opts.piped.trim()),
    ),
    readLine: () =>
      Effect.succeed(
        opts.piped === undefined || (opts.piped.split(/\r?\n/u)[0] ?? "").trim() === ""
          ? Option.none()
          : Option.some((opts.piped.split(/\r?\n/u)[0] ?? "").trim()),
      ),
  });
}

// `invalid` exercises the real `sbp_` token validator via `getAccessToken`.
function mockCredentials(invalid = false, accessToken?: Option.Option<Redacted.Redacted<string>>) {
  return Layer.succeed(CommandCredentials, {
    getAccessToken: invalid
      ? validateAccessToken("not_sbp").pipe(Effect.map((t) => Option.some(Redacted.make(t))))
      : Effect.succeed(accessToken ?? Option.some(Redacted.make(VALID_TOKEN))),
    saveAccessToken: () => Effect.die("unexpected credentials write in test"),
    deleteAccessToken: Effect.die("unexpected credentials delete in test"),
    deleteAllProjectCredentials: Effect.die("unexpected project-credential sweep in test"),
    deleteProjectCredential: () => Effect.die("unexpected project-credential delete in test"),
  });
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  isLocal?: boolean;
  agent?: "auto" | "yes" | "no";
  outputFlag?: "env" | "json" | "pretty" | "toml" | "yaml" | "table" | "csv";
  aiTool?: string;
  stdinTTY?: boolean;
  piped?: string;
  result?: QueryResult;
  rlsTables?: ReadonlyArray<string>;
  rlsFails?: boolean;
  queryFails?: boolean;
  linkedStatus?: number;
  linkedBody?: string;
  networkFail?: boolean;
  accessToken?: Option.Option<Redacted.Redacted<string>>;
  accessTokenInvalid?: boolean;
  workdir?: string;
  unlinked?: boolean;
  refReadFails?: boolean;
  resolveFails?: boolean;
  /** Runs the real linked-project cache layer against the temp `workdir`, answering its project lookup. */
  realCache?: boolean;
  /** Runs the real `DbConfigResolver` against the temp `workdir`; the test serves its Management API calls. */
  realDbConfig?: boolean;
  /** `--yes`; on by default so hosted runs reach the query. */
  yes?: boolean;
  interactive?: boolean;
  confirm?: ReadonlyArray<boolean>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: opts.interactive,
    promptConfirmResponses: opts.confirm,
  });
  const dbConnection = mockDbConnection(opts);
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const telemetryOutputFormat = mockTelemetryOutputFormat();
  const platformApi = mockCommandPlatformApi({
    handler: (request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          opts.realCache === true &&
            request.method === "GET" &&
            request.url.endsWith(`/v1/projects/${REF}`)
            ? new Response(
                JSON.stringify({
                  ref: REF,
                  name: "alpha",
                  organization_id: "org-123",
                  organization_slug: "acme",
                  id: REF,
                  region: "us-east-1",
                  created_at: "2026-01-01T00:00:00Z",
                  status: "ACTIVE_HEALTHY",
                  database: {
                    host: "db.example.com",
                    version: "15",
                    postgres_engine: "15",
                    release_channel: "ga",
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              )
            : new Response(opts.linkedBody ?? "[]", { status: opts.linkedStatus ?? 201 }),
        ),
      ),
    network: opts.networkFail === true ? "fail" : undefined,
  });
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    opts.realCache === true
      ? realLinkedProjectCache({
          httpClient: platformApi.httpClientLayer,
          cliSettings: mockCommandSettings({ workdir: opts.workdir ?? "/work/project" }),
        })
      : cache.layer,
    telemetryOutputFormat.layer,
    opts.realDbConfig === true
      ? realDbConfigResolver({
          workdir: opts.workdir ?? "/work/project",
          dbConnection: dbConnection.layer,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        })
      : mockResolver(opts.isLocal, opts.resolveFails),
    dbConnection.layer,
    mockProjectRef(opts.unlinked, opts.refReadFails),
    cliConfigValuesTestLayer,
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "no" }),
    Layer.succeed(YesFlag, opts.yes ?? true),
    Layer.succeed(CliArgs, { args: [] }),
    mockTty({ stdinIsTty: opts.interactive ?? false }),
    mockStdin({ isTTY: opts.stdinTTY, piped: opts.piped }),
    Layer.succeed(Random, { randomHex: () => Effect.succeed(BOUNDARY) }),
    Layer.succeed(AiTool, {
      name: opts.aiTool === undefined ? Option.none() : Option.some(opts.aiTool),
    }),
    Layer.succeed(AgentFlag, opts.agent ?? "auto"),
    Layer.succeed(
      OutputFlag,
      opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
    ),
    Layer.succeed(DnsResolverFlag, "native"),
    mockCommandSettings({
      workdir: opts.workdir ?? "/work/project",
      accessToken: opts.accessToken,
    }),
    mockCredentials(opts.accessTokenInvalid === true, opts.accessToken),
    platformApi.factoryLayer,
    BunServices.layer,
  );
  return { layer, out, telemetry, cache, telemetryOutputFormat, platformApi, dbConnection };
}

const flags = (over: Partial<DbQueryFlags> = {}): DbQueryFlags => ({
  sql: over.sql ?? Option.none(),
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
  file: over.file ?? Option.none(),
  readOnly: over.readOnly ?? false,
});

const SELECT_RESULT: QueryResult = {
  fields: ["id", "name"],
  rows: [
    [1, "alice"],
    [2, "bob"],
  ],
  commandTag: "SELECT 2",
};

describe("db query integration", () => {
  const tempRoot = useTempWorkdir("supabase-db-query-int-");

  it.effect("runs SQL passed as a positional argument and renders a table for humans", () => {
    const { layer, out, cache } = setup({ result: SELECT_RESULT });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select * from users"), local: true }));
      expect(out.stdoutText).toContain("│ id │ name  │");
      expect(out.stdoutText).toContain("│ 1  │ alice │");
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders a local float8 column in exponent notation, integer columns plain", () => {
    // OIDs: int8=20 → plain; float8=701 → exponent form (select 1000000::int8, 1000000::float8).
    const { layer, out } = setup({
      result: {
        fields: ["n", "f"],
        fieldTypeIds: [20, 701],
        rows: [[1000000, 1000000]],
        commandTag: "SELECT 1",
      },
    });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(out.stdoutText).toContain("│ 1000000 │ 1e+06 │");
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks with a preview of the SQL before running it on a hosted --db-url target", () => {
    const { layer, out, dbConnection } = setup({
      result: SELECT_RESULT,
      isLocal: false,
      yes: false,
      interactive: true,
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* dbQuery(
        flags({ sql: Option.some("delete  from\n users"), dbUrl: Option.some("postgres://x/y") }),
      );
      expect(out.stderrText).toContain("sql: delete from users");
      expect(out.promptConfirmCalls).toHaveLength(1);
      expect(dbConnection.statements).toEqual(["delete  from\n users"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs a local query without asking for consent", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, yes: false });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("delete from users"), local: true }));
      expect(out.promptConfirmCalls).toEqual([]);
      expect(out.stdoutText).toContain("alice");
    }).pipe(Effect.provide(layer));
  });

  it.effect("errors when no SQL is provided on a TTY", () => {
    const { layer } = setup({ stdinTTY: true });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(flags({ local: true })).pipe(Effect.exit);
      expect(failMessage(exit)).toBe(
        "no SQL query provided. Pass SQL as an argument, via --file, or pipe to stdin",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads SQL piped via stdin", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, stdinTTY: false, piped: "select 1\n" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ local: true }));
      expect(out.stdoutText).toContain("alice");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads SQL from --file", () => {
    const { layer, out } = setup({ result: SELECT_RESULT });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-query-" });
      const filePath = path.join(dir, "q.sql");
      yield* fs.writeFileString(filePath, "select * from users");
      yield* dbQuery(flags({ local: true, file: Option.some(filePath) }));
      expect(out.stdoutText).toContain("alice");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("resolves a relative --file against the workdir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-query-wd-" });
      yield* fs.writeFileString(path.join(dir, "q.sql"), "select * from users");
      const { layer, out } = setup({ result: SELECT_RESULT, workdir: dir });
      yield* dbQuery(flags({ local: true, file: Option.some("q.sql") })).pipe(
        Effect.provide(layer),
      );
      expect(out.stdoutText).toContain("alice");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("errors when --file cannot be read", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* dbQuery(
        flags({ local: true, file: Option.some("/no/such/file.sql") }),
      ).pipe(Effect.exit);
      expect(failMessage(exit)).toContain("failed to read SQL file");
    }).pipe(Effect.provide(layer));
  });

  it.effect("errors on empty stdin", () => {
    const { layer } = setup({ stdinTTY: false, piped: "   " });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(flags({ local: true })).pipe(Effect.exit);
      expect(failMessage(exit)).toBe("no SQL provided via stdin");
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints the command tag for DDL with no result columns", () => {
    const { layer, out } = setup({ result: { fields: [], rows: [], commandTag: "CREATE TABLE" } });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("create table t()"), local: true }));
      expect(out.stdoutText).toBe("CREATE TABLE\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders JSON for agents by default with the untrusted-data envelope", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      const parsed = yield* decodeJson(out.stdoutText);
      expect(parsed).toHaveProperty("boundary", BOUNDARY);
      expect(parsed).toHaveProperty("rows", [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
      expect(out.stdoutText).toContain(`\\u003c${BOUNDARY}\\u003e`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("auto-detects an agent from AiTool and defaults to JSON", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "auto", aiTool: "cursor" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(yield* decodeJson(out.stdoutText)).toHaveProperty("boundary", BOUNDARY);
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders plain JSON (no envelope) for a human with -o json", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "no", outputFlag: "json" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      const parsed = yield* decodeJson(out.stdoutText);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders plain JSON for --output-format json with --agent no", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "no", format: "json" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(yield* decodeJson(out.stdoutText)).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a result event for --output-format stream-json with --agent no", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "no", format: "stream-json" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(out.stdoutText.trimEnd().split("\n")).toHaveLength(1);
      expect(yield* decodeJson(out.stdoutText)).toEqual(
        expect.objectContaining({
          type: "result",
          data: [
            { id: 1, name: "alice" },
            { id: 2, name: "bob" },
          ],
        }),
      );
      expect(out.stdoutText).toMatch(
        /^\{"type":"result","data":\[ {2}\{ {4}"id": 1, {4}"name": "alice" {2}\}, {2}\{ {4}"id": 2, {4}"name": "bob" {2}\}\],"timestamp":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\}\n$/u,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("preserves exact bigint tokens in --output-format stream-json", () => {
    const { layer, out } = setup({
      result: {
        fields: ["n"],
        fieldTypeIds: [20],
        rows: [["9223372036854775807"]],
        commandTag: "SELECT 1",
      },
      agent: "no",
      format: "stream-json",
    });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(out.stdoutText.trimEnd().split("\n")).toHaveLength(1);
      expect(out.stdoutText).toContain('"n": 9223372036854775807');
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets --output pretty win over --output-format json", () => {
    const { layer, out } = setup({
      result: SELECT_RESULT,
      agent: "no",
      format: "json",
      outputFlag: "pretty",
    });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(out.stdoutText).toContain("│ id │ name  │");
      expect(out.messages.find((message) => message.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails JSON output on a non-finite float, no stdout", () => {
    const { layer, out } = setup({
      result: { fields: ["f"], fieldTypeIds: [701], rows: [[Number.NaN]], commandTag: "SELECT 1" },
      agent: "no",
      outputFlag: "json",
    });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(
        flags({ sql: Option.some("select 'NaN'::float8"), local: true }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toContain("json: unsupported value: NaN");
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("records the resolved -o as the telemetry output_format", () => {
    const human = setup({ result: SELECT_RESULT, agent: "no" });
    const agent = setup({ result: SELECT_RESULT, agent: "yes" });
    const csv = setup({ result: SELECT_RESULT, agent: "no", outputFlag: "csv" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true })).pipe(
        Effect.provide(human.layer),
      );
      expect(human.telemetryOutputFormat.format).toBe("table");
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true })).pipe(
        Effect.provide(agent.layer),
      );
      expect(agent.telemetryOutputFormat.format).toBe("json");
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true })).pipe(
        Effect.provide(csv.layer),
      );
      expect(csv.telemetryOutputFormat.format).toBe("csv");
    });
  });

  it.effect("renders CSV with -o csv", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "no", outputFlag: "csv" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(out.stdoutText).toBe("id,name\n1,alice\n2,bob\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("honors an explicit -o table over the agent JSON default", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes", outputFlag: "table" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(out.stdoutText).toContain("│ id │ name  │");
      expect(out.stdoutText).not.toContain("boundary");
    }).pipe(Effect.provide(layer));
  });

  it.effect("honors an explicit -o csv over the agent JSON default", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes", outputFlag: "csv" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(out.stdoutText).toBe("id,name\n1,alice\n2,bob\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("attaches an RLS advisory in agent JSON mode", () => {
    const { layer, out } = setup({
      result: SELECT_RESULT,
      agent: "yes",
      rlsTables: ["public.users"],
    });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(yield* decodeJson(out.stdoutText)).toHaveProperty(["advisory", "id"], "rls_disabled");
    }).pipe(Effect.provide(layer));
  });

  it.effect("omits the advisory when the RLS check fails", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes", rlsFails: true });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(yield* decodeJson(out.stdoutText)).not.toHaveProperty("advisory");
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the --db-url/config before reading SQL", () => {
    const { layer } = setup({ resolveFails: true });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(
        flags({ dbUrl: Option.some("bad"), file: Option.some("/nope/missing.sql") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toContain("failed to parse connection string");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with DbQueryExecError when the query errors", () => {
    const { layer } = setup({ queryFails: true });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(flags({ sql: Option.some("bad"), local: true })).pipe(
        Effect.exit,
      );
      expect(failMessage(exit)).toContain("failed to execute query");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects conflicting targets (--linked --local) before running any SQL", () => {
    const { layer, cache, dbConnection } = setup();
    return Effect.gen(function* () {
      const exit = yield* dbQuery(
        flags({ sql: Option.some("select 1"), linked: true, local: true }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(TargetSelectorConflictError);
      }
      expect(dbConnection.statements).toEqual([]);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats --local=false --linked=false as absent and queries the local target", () => {
    const { layer, out, cache } = setup({ result: SELECT_RESULT });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1") }));
      expect(out.stdoutText).toContain("alice");
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails an unlinked --linked query without prompting for a project", () => {
    const { layer } = setup({ unlinked: true });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe("Cannot find project ref. Have you run supabase link?");
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces a project-ref read failure instead of reporting not-linked", () => {
    const { layer } = setup({ refReadFails: true });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toContain("failed to load project ref");
      expect(failMessage(exit)).not.toContain("Cannot find project ref");
    }).pipe(Effect.provide(layer));
  });

  it.effect("queries the linked project over HTTP and writes the linked-project cache", () => {
    const { layer, out, cache, platformApi } = setup({
      linkedStatus: 201,
      linkedBody: '[{"name":"alice","id":1}]',
    });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true }));
      expect(out.stdoutText).toContain("│ name  │ id │");
      expect(platformApi.requests).toHaveLength(1);
      expect(platformApi.requests[0]).toMatchObject({
        method: "POST",
        url: `https://api.supabase.com/v1/projects/${REF}/database/query`,
        body: { query: "select 1" },
      });
      expect(cache.cached).toBe(true);
      assertPermissionDrift({
        command: "db query",
        activeFlags: { linked: true },
        requests: platformApi.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fills the linked-project cache through the real cache layer", () => {
    const { layer, platformApi } = setup({
      linkedStatus: 201,
      linkedBody: '[{"name":"alice","id":1}]',
      realCache: true,
      workdir: tempRoot.current,
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);
      yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true }));
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({ ref: REF });
      expect(platformApi.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `POST https://api.supabase.com/v1/projects/${REF}/database/query`,
        `GET https://api.supabase.com/v1/projects/${REF}`,
      ]);
      assertPermissionDrift({
        command: "db query",
        activeFlags: { linked: true },
        requests: platformApi.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "queries a linked project through the real resolver without minting a login role",
    () => {
      const { layer, platformApi } = setup({
        linkedStatus: 201,
        linkedBody: '[{"name":"alice","id":1}]',
        realCache: true,
        realDbConfig: true,
        workdir: tempRoot.current,
      });
      const resolverRequests: Array<{ readonly method: string; readonly path: string }> = [];
      return Effect.gen(function* () {
        yield* stubManagementApi(resolverRequests, (method, path) => {
          if (method === "GET" && path === `/v1/projects/${REF}/config/database/pooler`) {
            return Response.json(primaryPoolerConfigs(REF));
          }
          if (method === "POST" && path === `/v1/projects/${REF}/cli/login-role`) {
            return Response.json(
              { role: "cli_login_role", password: "temporary-role-password", ttl_seconds: 3600 },
              { status: 201 },
            );
          }
          return undefined;
        });
        yield* dbQuery(
          flags({
            sql: Option.some("select 1"),
            linked: true,
            projectRef: Option.some(REF),
          }),
        );
        expect(resolverRequests).toEqual([]);
        assertPermissionDrift({
          command: "db query",
          activeFlags: { linked: true, "project-ref": REF },
          requests: platformApi.requests,
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(
            { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
            { preserveEmptyStrings: true },
          ),
        ),
      );
    },
  );

  it.effect("queries the project given via --project-ref without a linked workdir", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, out, cache, platformApi } = setup({
      linkedStatus: 201,
      linkedBody: '[{"name":"alice","id":1}]',
      unlinked: true,
    });
    return Effect.gen(function* () {
      yield* dbQuery(
        flags({
          sql: Option.some("select 1"),
          linked: true,
          projectRef: Option.some(FLAG_REF),
        }),
      );
      expect(out.stdoutText).toContain("│ name  │ id │");
      expect(
        platformApi.requests.some((req) =>
          req.url.includes(`/v1/projects/${FLAG_REF}/database/query`),
        ),
      ).toBe(true);
      expect(cache.cached).toBe(true);
      expect(cache.cachedRef).toBe(FLAG_REF);
      assertPermissionDrift({
        command: "db query",
        activeFlags: { linked: true, "project-ref": FLAG_REF },
        requests: platformApi.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("--project-ref overrides an already-linked workdir's project ref", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, cache, platformApi } = setup({
      linkedStatus: 201,
      linkedBody: '[{"name":"alice","id":1}]',
    });
    return Effect.gen(function* () {
      yield* dbQuery(
        flags({
          sql: Option.some("select 1"),
          linked: true,
          projectRef: Option.some(FLAG_REF),
        }),
      );
      expect(
        platformApi.requests.some((req) =>
          req.url.includes(`/v1/projects/${FLAG_REF}/database/query`),
        ),
      ).toBe(true);
      expect(cache.cached).toBe(true);
      expect(cache.cachedRef).toBe(FLAG_REF);
      expect(cache.cachedRef).not.toBe(REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("selects the linked project from --project-ref alone", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, cache, platformApi } = setup({
      linkedStatus: 201,
      linkedBody: '[{"name":"alice","id":1}]',
    });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), projectRef: Option.some(FLAG_REF) }));
      expect(
        platformApi.requests.some((req) =>
          req.url.includes(`/v1/projects/${FLAG_REF}/database/query`),
        ),
      ).toBe(true);
      expect(cache.cachedRef).toBe(FLAG_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --project-ref combined with --local", () => {
    const { layer, out, cache, platformApi } = setup({ result: SELECT_RESULT });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(
        flags({
          sql: Option.some("select 1"),
          local: true,
          projectRef: Option.some("flagflagflagflagflag"),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(TargetProjectRefConflictError);
      }
      expect(out.stdoutText).toBe("");
      expect(platformApi.requests).toEqual([]);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("follows a remote workspace target when no selector flag is given", () => {
    const { layer, out, cache } = setup({
      linkedStatus: 201,
      linkedBody: '[{"name":"alice","id":1}]',
    });
    return Effect.gen(function* () {
      yield* withConfigEnv(
        { SUPABASE_TARGET: "remote" },
        dbQuery(flags({ sql: Option.some("select 1"), linked: false })),
      );
      expect(out.stdoutText).toContain("│ name  │ id │");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never resolves a database connection for a linked query", () => {
    const { layer, out, cache } = setup({
      resolveFails: true,
      linkedStatus: 201,
      linkedBody: '[{"id":1}]',
    });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true }));
      expect(out.stdoutText).toContain("│ id │");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches the linked project even when SQL resolution fails", () => {
    const { layer, cache } = setup({ stdinTTY: true });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(flags({ linked: true })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toContain("no SQL query provided");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "errors when the linked API returns a non-201 but still caches the linked project",
    () => {
      const { layer, cache } = setup({
        linkedStatus: 400,
        linkedBody: '{"message":"syntax error"}',
      });
      return Effect.gen(function* () {
        const exit = yield* dbQuery(flags({ sql: Option.some("bad"), linked: true })).pipe(
          Effect.exit,
        );
        expect(failMessage(exit)).toBe('unexpected status 400: {"message":"syntax error"}');
        expect(cache.cached).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("strips terminal control characters from a linked error body", () => {
    const { layer } = setup({ linkedStatus: 400, linkedBody: "bad\u001b[31m query" });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(flags({ sql: Option.some("bad"), linked: true })).pipe(
        Effect.exit,
      );
      expect(failMessage(exit)).toBe("unexpected status 400: bad[31m query");
    }).pipe(Effect.provide(layer));
  });

  it.effect("handles an empty linked result array", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: "[]" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1 where false"), linked: true }));
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints the raw body when the linked response is not a JSON array", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: '{"command":"INSERT"}' });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("insert ..."), linked: true }));
      expect(out.stdoutText).toBe('{"command":"INSERT"}\n');
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints the raw body when the linked response is not valid JSON", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: "CREATE TABLE" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("create ..."), linked: true }));
      expect(out.stdoutText).toBe("CREATE TABLE\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders linked agent JSON with the envelope (no advisory on the linked path)", () => {
    const { layer, out } = setup({
      agent: "yes",
      linkedStatus: 201,
      linkedBody: '[{"id":1}]',
    });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true }));
      const parsed = yield* decodeJson(out.stdoutText);
      expect(parsed).toHaveProperty("boundary", BOUNDARY);
      expect(parsed).toHaveProperty("rows", [{ id: 1 }]);
      expect(parsed).not.toHaveProperty("advisory");
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to map keys when the first linked row has no orderable keys", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: "[null]" });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true }));
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders NULL for a null row object in a linked result", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: '[{"a":1},null]' });
    return Effect.gen(function* () {
      yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true }));
      expect(out.stdoutText).toContain("NULL");
      expect(out.stdoutText).toContain("│ 1");
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps a linked HTTP transport failure to an exec error", () => {
    const { layer } = setup({ networkFail: true });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true })).pipe(
        Effect.exit,
      );
      expect(failMessage(exit)).toContain("failed to execute query: ");
    }).pipe(Effect.provide(layer));
  });

  it.effect("requires login before querying --linked", () => {
    const { layer } = setup({ accessToken: Option.none() });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true })).pipe(
        Effect.exit,
      );
      expect(failMessage(exit)).toContain("Access token not provided");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an invalid env access token before the linked query", () => {
    const { layer, out } = setup({ accessTokenInvalid: true, linkedStatus: 201 });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toContain("Invalid access token format");
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs the --linked login preflight before reading --file", () => {
    const { layer } = setup({ accessToken: Option.none() });
    return Effect.gen(function* () {
      const exit = yield* dbQuery(
        flags({ linked: true, file: Option.some("/no/such/file.sql") }),
      ).pipe(Effect.exit);
      expect(failMessage(exit)).toContain("Access token not provided");
      expect(failMessage(exit)).not.toContain("failed to read SQL file");
    }).pipe(Effect.provide(layer));
  });

  describe("--read-only", () => {
    it.effect("brackets the statement in a read-only transaction on a local target", () => {
      const { layer, out, dbConnection } = setup({ result: SELECT_RESULT });
      return Effect.gen(function* () {
        yield* dbQuery(flags({ sql: Option.some("select 1"), local: true, readOnly: true }));
        expect(dbConnection.statements).toEqual([
          "BEGIN READ ONLY",
          READ_ONLY_LOCK_TIMEOUT_SQL,
          "select 1",
          "ROLLBACK",
        ]);
        expect(out.stdoutText).toContain("alice");
      }).pipe(Effect.provide(layer));
    });

    it.effect("fails a write inside a read statement and still rolls the transaction back", () => {
      const sql = "with d as (delete from t returning *) select * from d";
      const { layer, dbConnection } = setup();
      return Effect.gen(function* () {
        const exit = yield* dbQuery(
          flags({ sql: Option.some(sql), local: true, readOnly: true }),
        ).pipe(Effect.exit);
        expect(failMessage(exit)).toContain("read-only transaction");
        expect(dbConnection.statements).toEqual([
          "BEGIN READ ONLY",
          READ_ONLY_LOCK_TIMEOUT_SQL,
          sql,
          "ROLLBACK",
        ]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("lets the same write through without --read-only", () => {
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* dbQuery(flags({ sql: Option.some("insert into t values (1)"), local: true }));
        expect(out.stdoutText).toBe("CREATE TABLE\n");
      }).pipe(Effect.provide(layer));
    });

    it.effect("runs in a read-only transaction on a --db-url target", () => {
      const { layer, dbConnection } = setup({
        result: SELECT_RESULT,
        isLocal: false,
        yes: false,
      });
      return Effect.gen(function* () {
        yield* dbQuery(
          flags({
            sql: Option.some("select 1"),
            dbUrl: Option.some("postgres://x/y"),
            readOnly: true,
          }),
        );
        expect(dbConnection.statements).toEqual([
          "BEGIN READ ONLY",
          READ_ONLY_LOCK_TIMEOUT_SQL,
          "select 1",
          "ROLLBACK",
        ]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("sends read_only to the Management API for a linked target", () => {
      const { layer, platformApi } = setup({ linkedStatus: 201, linkedBody: '[{"id":1}]' });
      return Effect.gen(function* () {
        yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true, readOnly: true }));
        expect(platformApi.requests.map(({ body }) => body)).toEqual([
          { query: "select 1", read_only: true },
        ]);
      }).pipe(Effect.provide(layer));
    });

    const rejectedTargets = [
      ["a local target", { local: true }, {}],
      ["a --db-url target", { dbUrl: Option.some("postgres://x/y") }, { isLocal: false }],
      ["a linked target", { linked: true }, {}],
    ] as const;
    for (const [name, target, opts] of rejectedTargets) {
      it.effect(
        `refuses COMMIT; DELETE before connecting, calling the API or asking on ${name}`,
        () => {
          const sessionOpts = {
            ...opts,
            result: SELECT_RESULT,
            linkedStatus: 201,
            linkedBody: '[{"id":1}]',
            yes: false,
            interactive: true,
            confirm: [true],
          };
          const rejected = setup(sessionOpts);
          const read = setup(sessionOpts);
          return Effect.gen(function* () {
            const exit = yield* dbQuery(
              flags({ ...target, sql: Option.some("COMMIT; DELETE FROM users"), readOnly: true }),
            ).pipe(Effect.provide(rejected.layer), Effect.exit);
            expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(
              DbQueryReadOnlyStatementError,
            );
            expect(failMessage(exit)).toBe(
              "--read-only only allows SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN statements (found: COMMIT)",
            );
            expect(rejected.dbConnection.connects).toBe(0);
            expect(rejected.dbConnection.statements).toEqual([]);
            expect(rejected.platformApi.requests).toEqual([]);
            expect(rejected.out.promptConfirmCalls).toEqual([]);

            yield* dbQuery(
              flags({ ...target, sql: Option.some("select * from users"), readOnly: true }),
            ).pipe(Effect.provide(read.layer));
            expect(read.out.promptConfirmCalls).toEqual([]);
            expect(read.out.stdoutText).not.toBe("");
          });
        },
      );
    }

    const refusedStatements = [
      ["a statement that is not a read", "CLUSTER users", "CLUSTER"],
      ["a role switch", "SET ROLE postgres", "SET"],
      [
        "a nested comment that hides a commit",
        "/* /* */* x */ COMMIT; DELETE FROM users; /* */",
        "COMMIT",
      ],
      [
        "an unterminated comment",
        "select 1 /* COMMIT",
        "an unterminated comment, quote or dollar quote",
      ],
    ] as const;
    for (const [name, sql, found] of refusedStatements) {
      it.effect(`refuses ${name} on a local target without connecting`, () => {
        const { layer, dbConnection } = setup({ result: SELECT_RESULT });
        return Effect.gen(function* () {
          const exit = yield* dbQuery(
            flags({ sql: Option.some(sql), local: true, readOnly: true }),
          ).pipe(Effect.exit);
          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(
            DbQueryReadOnlyStatementError,
          );
          expect(failMessage(exit)).toContain(`(found: ${found})`);
          expect(dbConnection.connects).toBe(0);
        }).pipe(Effect.provide(layer));
      });
    }

    it.effect("omits read_only from the Management API request by default", () => {
      const { layer, platformApi } = setup({ linkedStatus: 201, linkedBody: '[{"id":1}]' });
      return Effect.gen(function* () {
        yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true }));
        expect(platformApi.requests.map(({ body }) => body)).toEqual([{ query: "select 1" }]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("skips the hosted consent that a plain linked query needs", () => {
      const refused = setup({ linkedStatus: 201, linkedBody: '[{"id":1}]', yes: false });
      const allowed = setup({ linkedStatus: 201, linkedBody: '[{"id":1}]', yes: false });
      return Effect.gen(function* () {
        const exit = yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true })).pipe(
          Effect.provide(refused.layer),
          Effect.exit,
        );
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(
          HostedMutationConsentRequiredError,
        );
        expect(refused.platformApi.requests).toEqual([]);

        yield* dbQuery(flags({ sql: Option.some("select 1"), linked: true, readOnly: true })).pipe(
          Effect.provide(allowed.layer),
        );
        expect(allowed.out.promptConfirmCalls).toEqual([]);
        expect(allowed.platformApi.requests).toHaveLength(1);
      });
    });
  });
});

describeHostedConsent("db query", {
  invoke: () => {
    const platformApi = mockCommandPlatformApi({ response: { status: 201, body: [{ id: 1 }] } });
    return {
      run: dbQuery(
        flags({
          sql: Option.some("insert into t values (1)"),
          linked: true,
          projectRef: Option.some(REF),
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            mockResolver(false),
            mockDbConnection({}).layer,
            platformApi.factoryLayer,
            mockCredentials(),
            cliConfigValuesTestLayer,
            mockTelemetryOutputFormat().layer,
            Layer.succeed(Random, { randomHex: () => Effect.succeed(BOUNDARY) }),
            Layer.succeed(AiTool, { name: Option.none() }),
            Layer.succeed(AgentFlag, "no"),
            Layer.succeed(DnsResolverFlag, "native"),
          ),
        ),
      ),
      mutations: () => platformApi.requests.filter(({ method }) => method === "POST").length,
    };
  },
});
