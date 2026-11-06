import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option } from "effect";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { configValuesLayer } from "../../../../../tests/helpers/config-values-layer.ts";
import { DbConfigResolver } from "../../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../../command-internal/db-config.types.ts";
import {
  DbConnection,
  type PgConnInput,
} from "../../../../command-internal/db-connection.service.ts";
import { DnsResolverFlag, OutputFlag, YesFlag } from "../../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import type { InspectConnectionFlags } from "../inspect-query.ts";
import { inspectDbCollationDrift } from "./collation-drift.handler.ts";

const LOCAL_CONN: PgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

const DRIFT_ROW = {
  database: "postgres",
  name: "public.users_email_key",
  table: "public.users",
  columns: "email",
  collation: "default",
  stored_version: "2.36",
  current_version: "2.39",
  key_type: "UNIQUE",
  size: "16 kB",
  can_refresh: true,
};

const flags: InspectConnectionFlags = {
  dbUrl: Option.none(),
  remote: Option.none(),
  linked: false,
  local: false,
  projectRef: Option.none(),
};

function setup(opts: {
  serverVersionNum: number;
  rows: ReadonlyArray<Record<string, unknown>>;
  format?: "text" | "json";
  connectFails?: boolean;
}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const queries: string[] = [];
  const connection = Layer.succeed(DbConnection, {
    connect: () =>
      opts.connectFails === true
        ? Effect.die("connect must not be reached")
        : Effect.succeed({
            exec: () => Effect.void,
            execBatch: () => Effect.void,
            extensionExists: () => Effect.succeed(false),
            queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
            copyToCsv: () => Effect.succeed(new Uint8Array()),
            query: (sql: string) => {
              queries.push(sql);
              return Effect.succeed(
                sql.includes("server_version_num")
                  ? [{ server_version_num: opts.serverVersionNum }]
                  : opts.rows,
              );
            },
          }),
  });
  const resolver = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) =>
      Effect.succeed({
        conn: LOCAL_CONN,
        isLocal: true,
        target: input.target,
      } satisfies ResolvedDbConnection),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  const runtime = buildTestRuntime({
    out,
    api: mockCommandPlatformApi({
      handler: (request) => Effect.succeed(jsonResponse(request, 200, [])),
    }),
    cliSettings: mockCommandSettings({
      workdir: "/tmp/collation-drift-test",
      projectId: Option.none(),
    }),
    telemetry: mockTelemetryStateTracked().layer,
  });
  const layer = Layer.mergeAll(
    runtime,
    resolver,
    connection,
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(YesFlag, false),
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "none" }),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({}, { preserveEmptyStrings: true })),
    configValuesLayer(),
  );
  return { layer, out, queries };
}

describe("inspect db collation-drift", () => {
  it.effect("PG15+ reads the default collation version and prints remediation steps", () => {
    const { layer, out, queries } = setup({
      serverVersionNum: 150000,
      rows: [DRIFT_ROW],
    });
    return Effect.gen(function* () {
      yield* inspectDbCollationDrift(flags);
      expect(queries[1]).toContain("pg_database_collation_actual_version");
      expect(out.stdoutText).toContain("public.users_email_key");
      expect(out.stdoutText).toContain("bt_index_check");
      expect(out.stdoutText).toContain("REINDEX INDEX CONCURRENTLY public.users_email_key;");
      expect(out.stdoutText).toContain('ALTER DATABASE "postgres" REFRESH COLLATION VERSION;');
    }).pipe(Effect.provide(layer));
  });

  it.effect("pre-15 skips the default collation check and prints the healthy callout", () => {
    const { layer, out, queries } = setup({
      serverVersionNum: 140000,
      rows: [],
    });
    return Effect.gen(function* () {
      yield* inspectDbCollationDrift(flags);
      expect(queries[1]).not.toContain("datcollversion");
      expect(out.stdoutText).toContain("No recorded collation version mismatch");
      expect(out.stdoutText.replace(/\s+/g, " ")).toContain("not checked before PostgreSQL 15");
    }).pipe(Effect.provide(layer));
  });

  it.effect("json mode carries raw rows and the report severity", () => {
    const { layer, out } = setup({
      serverVersionNum: 160000,
      rows: [DRIFT_ROW],
      format: "json",
    });
    return Effect.gen(function* () {
      yield* inspectDbCollationDrift(flags);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "inspect db collation-drift",
          data: {
            rows: [DRIFT_ROW],
            report: expect.objectContaining({
              command: "collation-drift",
              severity: "critical",
            }),
          },
        }),
      );
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects -o/--output before connecting", () => {
    const { layer } = setup({ serverVersionNum: 170000, rows: [], connectFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(inspectDbCollationDrift(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          "the -o/--output flag is not supported by inspect db collation-drift; use --output-format json|stream-json instead.",
        );
        expect(Cause.pretty(exit.cause)).not.toContain("connect must not be reached");
      }
    }).pipe(Effect.provide(Layer.mergeAll(layer, Layer.succeed(OutputFlag, Option.some("json")))));
  });
});
