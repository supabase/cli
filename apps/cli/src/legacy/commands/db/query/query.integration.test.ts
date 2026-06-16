import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, type Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  mockLegacyCliConfig,
  mockLegacyCredentialsLayer,
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
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyTelemetryOutputFormat } from "../../../telemetry/legacy-telemetry-output-format.service.ts";
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

function mockResolver(isLocal = true) {
  return Layer.succeed(LegacyDbConfigResolver, {
    resolve: () => Effect.succeed({ conn: LOCAL_CONN, isLocal }),
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

function mockProjectRef(unlinked = false) {
  return Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(REF),
    resolveForLink: () => Effect.succeed(REF),
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
  workdir?: string;
  unlinked?: boolean;
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
    mockResolver(opts.isLocal),
    mockDbConnection(opts),
    mockProjectRef(opts.unlinked),
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
    mockLegacyCredentialsLayer,
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
  linked: over.linked ?? false,
  local: over.local ?? false,
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
      yield* legacyDbQuery(flags({ sql: Option.some("select * from users"), local: true }));
      expect(out.stderrText).toContain("Connecting to local database...");
      expect(out.stdoutText).toContain("│ id │ name  │");
      expect(out.stdoutText).toContain("│ 1  │ alice │");
      // The local path never resolves a project ref, so no linked-project cache write.
      expect(cache.cached).toBe(false);
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
      const exit = yield* legacyDbQuery(flags({ local: true })).pipe(Effect.exit);
      expect(failMessage(exit)).toBe(
        "no SQL query provided. Pass SQL as an argument, via --file, or pipe to stdin",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reads SQL piped via stdin", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, stdinTTY: false, piped: "select 1\n" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ local: true }));
      expect(out.stdoutText).toContain("alice");
    }).pipe(Effect.provide(layer));
  });

  it.live("reads SQL from --file", () => {
    const { layer, out } = setup({ result: SELECT_RESULT });
    const filePath = join(mkdtempSync(join(tmpdir(), "supabase-query-")), "q.sql");
    writeFileSync(filePath, "select * from users");
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ local: true, file: Option.some(filePath) }));
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
      yield* legacyDbQuery(flags({ local: true, file: Option.some("q.sql") }));
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
        flags({ local: true, file: Option.some("/no/such/file.sql") }),
      ).pipe(Effect.exit);
      expect(failMessage(exit)).toContain("failed to read SQL file");
    }).pipe(Effect.provide(layer));
  });

  it.live("errors on empty stdin", () => {
    const { layer } = setup({ stdinTTY: false, piped: "   " });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(flags({ local: true })).pipe(Effect.exit);
      expect(failMessage(exit)).toBe("no SQL provided via stdin");
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the command tag for DDL with no result columns", () => {
    const { layer, out } = setup({ result: { fields: [], rows: [], commandTag: "CREATE TABLE" } });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("create table t()"), local: true }));
      expect(out.stdoutText).toBe("CREATE TABLE\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders JSON for agents by default with the untrusted-data envelope", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: true }));
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
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(JSON.parse(out.stdoutText).boundary).toBe(BOUNDARY);
    }).pipe(Effect.provide(layer));
  });

  it.live("renders plain JSON (no envelope) for a human with -o json", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "no", goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: true }));
      const parsed = JSON.parse(out.stdoutText);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("records the resolved -o as the telemetry output_format (Go parity)", () => {
    // Go mirrors db query's resolved local -o onto the telemetry global: table for
    // humans, json for agents, and the explicit -o otherwise.
    const human = setup({ result: SELECT_RESULT, agent: "no" });
    const agent = setup({ result: SELECT_RESULT, agent: "yes" });
    const csv = setup({ result: SELECT_RESULT, agent: "no", goOutput: "csv" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: true })).pipe(
        Effect.provide(human.layer),
      );
      expect(human.telemetryOutputFormat.format).toBe("table");
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: true })).pipe(
        Effect.provide(agent.layer),
      );
      expect(agent.telemetryOutputFormat.format).toBe("json");
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: true })).pipe(
        Effect.provide(csv.layer),
      );
      expect(csv.telemetryOutputFormat.format).toBe("csv");
    });
  });

  it.live("renders CSV with -o csv", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "no", goOutput: "csv" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(out.stdoutText).toBe("id,name\n1,alice\n2,bob\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors an explicit -o table over the agent JSON default", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes", goOutput: "table" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(out.stdoutText).toContain("│ id │ name  │");
      expect(out.stdoutText).not.toContain("boundary");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors an explicit -o csv over the agent JSON default", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes", goOutput: "csv" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: true }));
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
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(JSON.parse(out.stdoutText).advisory.id).toBe("rls_disabled");
    }).pipe(Effect.provide(layer));
  });

  it.live("omits the advisory when the RLS check fails", () => {
    const { layer, out } = setup({ result: SELECT_RESULT, agent: "yes", rlsFails: true });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), local: true }));
      expect(JSON.parse(out.stdoutText).advisory).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyDbQueryExecError when the query errors", () => {
    const { layer } = setup({ queryFails: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(flags({ sql: Option.some("bad"), local: true })).pipe(
        Effect.exit,
      );
      expect(failMessage(exit)).toContain("failed to execute query");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects conflicting targets (--linked --local) before running any SQL", () => {
    // cobra MarkFlagsMutuallyExclusive("db-url", "linked", "local") fails before RunE.
    const { layer, cache } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(
        flags({ sql: Option.some("select 1"), linked: true, local: true }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe(
        "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
      );
      // Failure precedes target resolution, so no linked-project cache write.
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails an unlinked --linked query without prompting for a project", () => {
    // Go's --linked PreRun loads the ref or fails (ErrNotLinked); it never prompts.
    const { layer } = setup({ unlinked: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: true })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failMessage(exit)).toBe("Cannot find project ref. Have you run supabase link?");
    }).pipe(Effect.provide(layer));
  });

  // ---- linked path -------------------------------------------------------

  it.live("queries the linked project over HTTP and writes the linked-project cache", () => {
    const { layer, out, cache } = setup({
      linkedStatus: 201,
      linkedBody: '[{"name":"alice","id":1}]',
    });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: true }));
      expect(out.stdoutText).toContain("│ name  │ id │");
      // Go's PersistentPostRun caches the linked project after a --linked run.
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
        const exit = yield* legacyDbQuery(flags({ sql: Option.some("bad"), linked: true })).pipe(
          Effect.exit,
        );
        expect(failMessage(exit)).toContain("unexpected status 400");
        // Go runs the cache write in PersistentPostRun, so it fires on failure too.
        expect(cache.cached).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("handles an empty linked result array", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: "[]" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1 where false"), linked: true }));
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the raw body when the linked response is not a JSON array", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: '{"command":"INSERT"}' });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("insert ..."), linked: true }));
      expect(out.stdoutText).toBe('{"command":"INSERT"}\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the raw body when the linked response is not valid JSON", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: "CREATE TABLE" });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("create ..."), linked: true }));
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
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: true }));
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
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: true }));
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders NULL for a null row object in a linked result", () => {
    const { layer, out } = setup({ linkedStatus: 201, linkedBody: '[{"a":1},null]' });
    return Effect.gen(function* () {
      yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: true }));
      expect(out.stdoutText).toContain("NULL");
      expect(out.stdoutText).toContain("│ 1");
    }).pipe(Effect.provide(layer));
  });

  it.live("maps a linked HTTP transport failure to an exec error", () => {
    const { layer } = setup({ networkFail: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: true })).pipe(
        Effect.exit,
      );
      expect(failMessage(exit)).toContain("failed to execute query");
    }).pipe(Effect.provide(layer));
  });

  it.live("requires login before querying --linked", () => {
    const { layer } = setup({ accessToken: Option.none() });
    return Effect.gen(function* () {
      const exit = yield* legacyDbQuery(flags({ sql: Option.some("select 1"), linked: true })).pipe(
        Effect.exit,
      );
      expect(failMessage(exit)).toContain("Access token not provided");
    }).pipe(Effect.provide(layer));
  });
});
