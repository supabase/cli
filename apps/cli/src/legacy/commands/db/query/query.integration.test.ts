import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  LEGACY_VALID_TOKEN,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LegacyAgentFlag,
  LegacyDnsResolverFlag,
  LegacyOutputFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { Random } from "../../../../shared/runtime/random.service.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import { AiTool } from "../../../../shared/telemetry/ai-tool.service.ts";
import { LegacyCredentials } from "../../../auth/legacy-credentials.service.ts";
import { validateLegacyAccessToken } from "../../../auth/legacy-access-token.ts";
import {
  LegacyProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/legacy-project-ref.service.ts";
import { LegacyProjectNotLinkedError } from "../../../config/legacy-project-ref.errors.ts";
import { LegacyProjectRefReadError } from "../../../shared/legacy-temp-paths.ts";
import { LegacyTelemetryOutputFormat } from "../../../telemetry/legacy-telemetry-output-format.service.ts";
import { LegacyDbConfigParseUrlError } from "../../../shared/legacy-db-config.errors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
  type LegacyQueryResult,
} from "../../../shared/legacy-db-connection.service.ts";
import { LEGACY_RLS_CHECK_SQL } from "./query.advisory.ts";
import type { LegacyDbQueryFlags } from "./query.command.ts";
import { legacyDbQuery } from "./query.handler.ts";

const LOCAL_CONN: LegacyPgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};
const REF = "abcdefghijklmnopqrst";
const BOUNDARY = "00112233445566778899aabbccddeeff";

const failMessage = (exit: Exit.Exit<unknown, { readonly message: string }>): string | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error.message : undefined;

function mockResolver(isLocal = true, resolveFails = false) {
  return Layer.succeed(LegacyDbConfigResolver, {
    resolve: () =>
      resolveFails
        ? Effect.fail(
            new LegacyDbConfigParseUrlError({
              message: "failed to parse connection string: invalid dsn",
            }),
          )
        : Effect.succeed({ conn: LOCAL_CONN, isLocal }),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
}

function mockDbConnection(opts: {
  result?: LegacyQueryResult;
  rlsTables?: ReadonlyArray<string>;
  rlsFails?: boolean;
  queryFails?: boolean;
}) {
  return Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        exec: () => Effect.void,
        query: () => Effect.succeed([]),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: (sql: string) => {
          if (sql === LEGACY_RLS_CHECK_SQL) {
            return opts.rlsFails === true
              ? Effect.fail(new LegacyDbExecError({ message: "advisory failed" }))
              : Effect.succeed({
                  fields: ["format"],
                  rows: (opts.rlsTables ?? []).map((table) => [table]),
                  commandTag: `SELECT ${(opts.rlsTables ?? []).length}`,
                });
          }
          return opts.queryFails === true
            ? Effect.fail(new LegacyDbExecError({ message: "failed to execute query: boom" }))
            : Effect.succeed(opts.result ?? { fields: [], rows: [], commandTag: "CREATE TABLE" });
        },
      }),
  });
}

function mockTelemetryOutputFormat() {
  let format: string | undefined;
  return {
    layer: Layer.succeed(LegacyTelemetryOutputFormat, {
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
  // The linked query preflight uses the hard `loadProjectRef`: it fails with
  // ErrNotLinked when absent and surfaces a `failed to load project ref` read error
  // (LegacyProjectRefReadError) on an unreadable ref file, rather than masking it.
  const loadProjectRef = () =>
    refReadFails
      ? Effect.fail(
          new LegacyProjectRefReadError({
            message: "failed to load project ref: permission denied",
          }),
        )
      : unlinked
        ? Effect.fail(new LegacyProjectNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }))
        : Effect.succeed(REF);
  return Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(REF),
    resolveForLink: () => Effect.succeed(REF),
    resolveOptional: () => Effect.succeed(unlinked ? Option.none() : Option.some(REF)),
    loadProjectRef,
    promptProjectRef: () => Effect.succeed(REF),
  });
}

function mockStdin(opts: { isTTY?: boolean; piped?: string }) {
  return Layer.succeed(Stdin, {
    isTTY: opts.isTTY ?? true,
    readPipedBytes: Effect.succeed(
      opts.piped === undefined ? Option.none() : Option.some(new TextEncoder().encode(opts.piped)),
    ),
    readPipedText: Effect.succeed(
      opts.piped === undefined || opts.piped.trim() === ""
        ? Option.none()
        : Option.some(opts.piped.trim()),
    ),
  });
}

function mockHttpClient(opts: { status?: number; body?: string; networkFail?: boolean }) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      opts.networkFail === true
        ? Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "ECONNREFUSED" }),
            }),
          )
        : Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(opts.body ?? "[]", {
                status: opts.status ?? 201,
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
    ),
  );
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  isLocal?: boolean;
  agent?: "auto" | "yes" | "no";
  goOutput?: "env" | "json" | "pretty" | "toml" | "yaml" | "table" | "csv";
  aiTool?: string;
  stdinTTY?: boolean;
  piped?: string;
  result?: LegacyQueryResult;
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
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const telemetryOutputFormat = mockTelemetryOutputFormat();
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    telemetryOutputFormat.layer,
    mockResolver(opts.isLocal, opts.resolveFails),
    mockDbConnection(opts),
    mockProjectRef(opts.unlinked, opts.refReadFails),
    mockStdin({ isTTY: opts.stdinTTY, piped: opts.piped }),
    Layer.succeed(Random, { randomHex: () => Effect.succeed(BOUNDARY) }),
    Layer.succeed(AiTool, {
      name: opts.aiTool === undefined ? Option.none() : Option.some(opts.aiTool),
    }),
    Layer.succeed(LegacyAgentFlag, opts.agent ?? "auto"),
    Layer.succeed(
      LegacyOutputFlag,
      opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    ),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    mockLegacyCliConfig({
      workdir: opts.workdir ?? "/work/project",
      accessToken: opts.accessToken,
    }),
    // The linked token check routes through `credentials.getAccessToken`, which Go's
    // `LoadAccessTokenFS` mirrors by validating the resolved token (env/keyring/file)
    // against `sbp_`. `accessTokenInvalid` exercises that via the real validator.
    Layer.succeed(LegacyCredentials, {
      getAccessToken:
        opts.accessTokenInvalid === true
          ? validateLegacyAccessToken("not_sbp").pipe(
              Effect.map((t) => Option.some(Redacted.make(t))),
            )
          : Effect.succeed(opts.accessToken ?? Option.some(Redacted.make(LEGACY_VALID_TOKEN))),
      saveAccessToken: () => Effect.die("unexpected legacy credentials write in test"),
      deleteAccessToken: Effect.die("unexpected legacy credentials delete in test"),
      deleteAllProjectCredentials: Effect.die("unexpected legacy project-credential sweep in test"),
      deleteProjectCredential: () =>
        Effect.die("unexpected legacy project-credential delete in test"),
    }),
    mockHttpClient({
      status: opts.linkedStatus,
      body: opts.linkedBody,
      networkFail: opts.networkFail,
    }),
    BunServices.layer,
  );
  return { layer, out, telemetry, cache, telemetryOutputFormat };
}

const flags = (over: Partial<LegacyDbQueryFlags> = {}): LegacyDbQueryFlags => ({
  sql: over.sql ?? Option.none(),
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? Option.none(),
  local: over.local ?? Option.none(),
  file: over.file ?? Option.none(),
});

const SELECT_RESULT: LegacyQueryResult = {
  fields: ["id", "name"],
  rows: [
    [1, "alice"],
    [2, "bob"],
  ],
  commandTag: "SELECT 2",
};

describe("legacy db query integration", () => {
  it.live("runs SQL passed as a positional argument and renders a table for humans", () => {
    const { layer, out, cache } = setup({ result: SELECT_RESULT });
    return Effect.gen(function* () {
      yield* legacyDbQuery(
        flags({ sql: Option.some("select * from users"), local: Option.some(true) }),
      );
      expect(out.stderrText).toContain("Connecting to local database...");
      expect(out.stdoutText).toContain("│ id │ name  │");
      expect(out.stdoutText).toContain("│ 1  │ alice │");
      // The local path never resolves a project ref, so no linked-project cache write.
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("renders a local float8 column with Go's %g, integer columns plain", () => {
    // OIDs: int8=20 → plain; float8=701 → %g (select 1000000::int8, 1000000::float8).
    const { layer, out } = setup({
      result: {
        fields: ["n", "f"],
        fieldTypeIds: [20, 701],
        rows: [[1000000, 1000000]],
        commandTag: "SELECT 1",
      },
    });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) }));
      expect(out.stdoutText).toContain("│ 1000000 │ 1e+06 │");
    }).pipe(Effect.provide(layer));
  });

  it.live("reports connecting to the remote database for a --db-url target", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, isLocal: false });
    return Effect.gen(function* () {
      yield* legacyDbQuery(
        flags({ sql: Option.some("select 1"), dbUrl: Option.some("postgres://x/y") }),
      );
      expect(out.stderrText).toContain("Connecting to remote database...");
    }).pipe(Effect.provide(layer));
  });

  it.live("errors when no SQL is provided on a TTY", () => {
    const { layer } = setup({ stdinTTY: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(flags({ local: Option.some(true) })).pipe(Effect.exit);
      expect(failMessage(exit)).toBe(
        "no SQL query provided. Pass SQL as an argument, via --file, or pipe to stdin",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reads SQL piped via stdin", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, stdinTTY: false, piped: "select 1\n" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ local: Option.some(true) }));
      expect(out.stdoutText).toContain("alice");
    }).pipe(Effect.provide(layer));
  });

  it.live("reads SQL from --file", () => {
    const { layer, out } = setup({ result: SELECT_RESULT });
    const filePath = join(mkdtempSync(join(tmpdir(), "supabase-query-")), "q.sql");
    writeFileSync(filePath, "select * from users");
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ local: Option.some(true), file: Option.some(filePath) }));
      expect(out.stdoutText).toContain("alice");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(filePath, { force: true }))),
    );
  });

  it.live("resolves a relative --file against the workdir", () => {
    // Go chdir's into the workdir before ResolveSQL reads --file, so a relative
    // path resolves against the workdir, not the original process cwd.
    const dir = mkdtempSync(join(tmpdir(), "supabase-query-wd-"));
    writeFileSync(join(dir, "q.sql"), "select * from users");
    const { layer, out } = setup({ result: SELECT_RESULT, workdir: dir });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ local: Option.some(true), file: Option.some("q.sql") }));
      expect(out.stdoutText).toContain("alice");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.live("errors when --file cannot be read", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ local: Option.some(true), file: Option.some("/no/such/file.sql") }),
      ).pipe(Effect.exit);
      expect(failMessage(exit)).toContain("failed to read SQL file");
    }).pipe(Effect.provide(layer));
  });

  it.live("errors on empty stdin", () => {
    const { layer } = setup({ stdinTTY: false, piped: "   " });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(flags({ local: Option.some(true) })).pipe(Effect.exit);
      expect(failMessage(exit)).toBe("no SQL provided via stdin");
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the command tag for DDL with no result columns", () => {
    const { layer, out } = setup({ result: { fields: [], rows: [], commandTag: "CREATE TABLE" } });
    return Effect.gen(function* () {
      yield* legacyDbQuery(
        flags({ sql: Option.some("create table t()"), local: Option.some(true) }),
      );
      expect(out.stdoutText).toBe("CREATE TABLE\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders JSON for agents by default with the untrusted-data envelope", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) }));
      const parsed = JSON.parse(out.stdoutText);
      expect(parsed.boundary).toBe(BOUNDARY);
      expect(parsed.rows).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
      expect(out.stdoutText).toContain(`\\u003c${BOUNDARY}\\u003e`);
    }).pipe(Effect.provide(layer));
  });

  it.live("auto-detects an agent from AiTool and defaults to JSON", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "auto", aiTool: "cursor" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) }));
      expect(JSON.parse(out.stdoutText).boundary).toBe(BOUNDARY);
    }).pipe(Effect.provide(layer));
  });

  it.live("renders plain JSON (no envelope) for a human with -o json", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "no", goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) }));
      const parsed = JSON.parse(out.stdoutText);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails JSON output on a non-finite float (Go's json.Encoder error), no stdout", () => {
    // select 'NaN'::float8 -o json — Go fails to encode and exits non-zero with empty
    // stdout, rather than emitting `null` like JSON.stringify.
    const { layer, out } = setup({
      result: { fields: ["f"], fieldTypeIds: [701], rows: [[Number.NaN]], commandTag: "SELECT 1" },
      agent: "no",
      goOutput: "json",
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ sql: Option.some("select 'NaN'::float8"), local: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toContain("json: unsupported value: NaN");
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("records the resolved -o as the telemetry output_format (Go parity)", () => {
    // Go mirrors db query's resolved local -o onto the telemetry global: table for
    // humans, json for agents, and the explicit -o otherwise.
    const human = setup({ result: SELECT_RESULT, agent: "no" });
    const agent = setup({ result: SELECT_RESULT, agent: "yes" });
    const csv = setup({ result: SELECT_RESULT, agent: "no", goOutput: "csv" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) })).pipe(
        Effect.provide(human.layer),
      );
      expect(human.telemetryOutputFormat.format).toBe("table");
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) })).pipe(
        Effect.provide(agent.layer),
      );
      expect(agent.telemetryOutputFormat.format).toBe("json");
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) })).pipe(
        Effect.provide(csv.layer),
      );
      expect(csv.telemetryOutputFormat.format).toBe("csv");
    });
  });

  it.live("renders CSV with -o csv", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "no", goOutput: "csv" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) }));
      expect(out.stdoutText).toBe("id,name\n1,alice\n2,bob\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors an explicit -o table over the agent JSON default", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes", goOutput: "table" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) }));
      expect(out.stdoutText).toContain("│ id │ name  │");
      expect(out.stdoutText).not.toContain("boundary");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors an explicit -o csv over the agent JSON default", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes", goOutput: "csv" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) }));
      expect(out.stdoutText).toBe("id,name\n1,alice\n2,bob\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("attaches an RLS advisory in agent JSON mode", () => {
    const { layer, out } = setup({
      result: SELECT_RESULT,
      agent: "yes",
      rlsTables: ["public.users"],
    });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) }));
      expect(JSON.parse(out.stdoutText).advisory.id).toBe("rls_disabled");
    }).pipe(Effect.provide(layer));
  });

  it.live("omits the advisory when the RLS check fails", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes", rlsFails: true });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: Option.some(true) }));
      expect(JSON.parse(out.stdoutText).advisory).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves the --db-url/config before reading SQL (Go root PreRun order)", () => {
    // db query --db-url 'bad' -f missing.sql: Go's ParseDatabaseConfig parses the
    // connection string in PreRunE before ResolveSQL, so the connection-string error
    // wins over the missing-file error.
    const { layer } = setup({ resolveFails: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ dbUrl: Option.some("bad"), file: Option.some("/nope/missing.sql") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toContain("failed to parse connection string");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyDbQueryExecError when the query errors", () => {
    const { layer } = setup({ queryFails: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ sql: Option.some("bad"), local: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(failMessage(exit)).toContain("failed to execute query");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects conflicting targets (--linked --local) before running any SQL", () => {
    // cobra MarkFlagsMutuallyExclusive("db-url", "linked", "local") fails before RunE.
    const { layer, cache } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({
          sql: Option.some("select 1"),
          linked: Option.some(true),
          local: Option.some(true),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
      );
      // Failure precedes target resolution, so no linked-project cache write.
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --local=false --linked=false as a target conflict (Go flag.Changed)", () => {
    // cobra keys the mutex off flag.Changed, so the explicit-false forms still count
    // as set and conflict — even though both values are false.
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({
          sql: Option.some("select 1"),
          linked: Option.some(false),
          local: Option.some(false),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("fails an unlinked --linked query without prompting for a project", () => {
    // Go's --linked PreRun loads the ref or fails (ErrNotLinked); it never prompts.
    const { layer } = setup({ unlinked: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ sql: Option.some("select 1"), linked: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe("Cannot find project ref. Have you run supabase link?");
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a project-ref read failure instead of reporting not-linked", () => {
    // Go's --linked PreRun uses the hard LoadProjectRef, which returns
    // `failed to load project ref` on an unreadable .temp/project-ref (project_ref.go:72)
    // rather than the not-linked message. The handler must surface that, not mask it.
    const { layer } = setup({ refReadFails: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ sql: Option.some("select 1"), linked: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toContain("failed to load project ref");
      expect(failMessage(exit)).not.toContain("Cannot find project ref");
    }).pipe(Effect.provide(layer));
  });

  // ---- linked path -------------------------------------------------------

  it.live("queries the linked project over HTTP and writes the linked-project cache", () => {
    const { layer, out, cache } = setup({
      linkedStatus: 201,
      linkedBody: '[{"name":"alice","id":1}]',
    });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: Option.some(true) }));
      expect(out.stdoutText).toContain("│ name  │ id │");
      // Go's PersistentPostRun caches the linked project after a --linked run.
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --linked=false as an explicit linked target (Go gates on flag.Changed)", () => {
    // pflag marks `--linked=false` as Changed, and Go's PreRun/RunE gate the linked
    // path on flag.Changed (not the value), so this still runs the linked HTTP path
    // rather than falling through to local.
    const { layer, out, cache } = setup({
      linkedStatus: 201,
      linkedBody: '[{"name":"alice","id":1}]',
    });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: Option.some(false) }));
      expect(out.stdoutText).toContain("│ name  │ id │");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves the linked DB config before the API call (Go root PreRun order)", () => {
    // Go's root ParseDatabaseConfig runs NewDbConfigWithPassword for --linked before
    // ResolveSQL/the Management API call: it loads+validates the remote-merged config
    // AND resolves the live DB connection (TCP probe / pooler / temp login-role), any
    // of which can fail early. A resolver failure must stop the query before the API.
    // (The config-validation-before-network parity is covered at the resolver level in
    // legacy-db-config.integration.test.ts.)
    const { layer, out, cache } = setup({
      resolveFails: true,
      linkedStatus: 201,
      linkedBody: '[{"id":1}]',
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ sql: Option.some("select 1"), linked: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toContain("failed to parse connection string");
      expect(out.stdoutText).toBe(""); // failed before emitting any query result
      // Go loads the ref (LoadProjectRef) before NewDbConfigWithPassword, and
      // ensureProjectGroupsCached runs on failure too, so a resolve-step failure
      // still refreshes the linked-project cache.
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("caches the linked project even when SQL resolution fails (Go PostRun)", () => {
    // The ref resolves and the DB config validates, but no SQL is provided on a TTY
    // (no --file / no stdin), so the query fails at ResolveSQL — before runLinked.
    // Go records flags.ProjectRef in the pre-run and ensureProjectGroupsCached runs
    // after the command returns even on a RunE error (cmd/root.go:176), so the
    // linked-project cache must still refresh.
    const { layer, cache } = setup({ stdinTTY: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(flags({ linked: Option.some(true) })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toContain("no SQL query provided");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "errors when the linked API returns a non-201 but still caches the linked project",
    () => {
      const { layer, cache } = setup({
        linkedStatus: 400,
        linkedBody: '{"message":"syntax error"}',
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbQuery(
          flags({ sql: Option.some("bad"), linked: Option.some(true) }),
        ).pipe(Effect.exit);
        expect(failMessage(exit)).toContain("unexpected status 400");
        // Go runs the cache write in PersistentPostRun, so it fires on failure too.
        expect(cache.cached).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("handles an empty linked result array", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: "[]" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(
        flags({ sql: Option.some("select 1 where false"), linked: Option.some(true) }),
      );
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the raw body when the linked response is not a JSON array", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: '{"command":"INSERT"}' });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("insert ..."), linked: Option.some(true) }));
      expect(out.stdoutText).toBe('{"command":"INSERT"}\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the raw body when the linked response is not valid JSON", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: "CREATE TABLE" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("create ..."), linked: Option.some(true) }));
      expect(out.stdoutText).toBe("CREATE TABLE\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders linked agent JSON with the envelope (no advisory on the linked path)", () => {
    const { layer, out } = setup({
      agent: "yes",
      linkedStatus: 201,
      linkedBody: '[{"id":1}]',
    });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: Option.some(true) }));
      const parsed = JSON.parse(out.stdoutText);
      expect(parsed.boundary).toBe(BOUNDARY);
      expect(parsed.rows).toEqual([{ id: 1 }]);
      expect(parsed.advisory).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("falls back to map keys when the first linked row has no orderable keys", () => {
    // A leading null row makes `orderedKeys` return [] → the handler falls back to
    // the first row's own keys (here also empty), rendering an empty table.
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: "[null]" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: Option.some(true) }));
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders NULL for a null row object in a linked result", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: '[{"a":1},null]' });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: Option.some(true) }));
      expect(out.stdoutText).toContain("NULL");
      expect(out.stdoutText).toContain("│ 1");
    }).pipe(Effect.provide(layer));
  });

  it.live("maps a linked HTTP transport failure to an exec error", () => {
    const { layer } = setup({ networkFail: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ sql: Option.some("select 1"), linked: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(failMessage(exit)).toContain("failed to execute query");
    }).pipe(Effect.provide(layer));
  });

  it.live("requires login before querying --linked", () => {
    const { layer } = setup({ accessToken: Option.none() });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ sql: Option.some("select 1"), linked: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(failMessage(exit)).toContain("Access token not provided");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "rejects an invalid env access token before the linked query (Go LoadAccessTokenFS)",
    () => {
      // Go's linked PreRun calls LoadAccessTokenFS, which validates the resolved token
      // (env/keyring/file) against `sbp_...` and fails with ErrInvalidToken before any
      // API request (cmd/db.go:303, access_token.go:24-33). So an invalid env token must
      // fail with the invalid-token error, not make the query and surface unexpected status.
      const { layer, out } = setup({ accessTokenInvalid: true, linkedStatus: 201 });
      return Effect.gen(function* () {
        const exit = yield* legacyDbQuery(
          flags({ sql: Option.some("select 1"), linked: Option.some(true) }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failMessage(exit)).toContain("Invalid access token format");
        // Failed at the token check → no query result emitted.
        expect(out.stdoutText).toBe("");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("runs the --linked login preflight before reading --file (Go PreRun order)", () => {
    // `db query --linked -f missing.sql` without a token must surface the login error,
    // not a file-read failure — Go checks the token in PreRun, before RunE's ResolveSQL.
    const { layer } = setup({ accessToken: Option.none() });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ linked: Option.some(true), file: Option.some("/no/such/file.sql") }),
      ).pipe(Effect.exit);
      expect(failMessage(exit)).toContain("Access token not provided");
      expect(failMessage(exit)).not.toContain("failed to read SQL file");
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a linked config/connection failure before the missing-token error", () => {
    // Go's root ParseDatabaseConfig (config + ref + NewDbConfigWithPassword) runs
    // before the query command's token check, so an unresolvable linked config must
    // surface ahead of the generic "supabase login" error — not be masked by it.
    const { layer } = setup({ accessToken: Option.none(), resolveFails: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ sql: Option.some("select 1"), linked: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(failMessage(exit)).toContain("failed to parse connection string");
      expect(failMessage(exit)).not.toContain("Access token not provided");
    }).pipe(Effect.provide(layer));
  });
});
