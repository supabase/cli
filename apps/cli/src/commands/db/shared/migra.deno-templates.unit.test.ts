import { EventEmitter } from "node:events";

import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";

import { dropObjectsSql } from "../../../command-internal/drop-objects.ts";
import { EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL } from "../../../command-internal/edge-runtime-script.service.ts";
import { migraDiffScript } from "./migra.deno-templates.ts";
import { listSchemasSql } from "./migra.ts";

type Side = "source" | "target";
type Verify = (connection: FakeConnection, done: (err?: Error) => void) => void;
type SetupFailure = "denyRole" | "dropConnection";

class SessionSetupError extends Data.TaggedError("SessionSetupError")<{
  readonly message: string;
}> {}

class FakeConnection extends EventEmitter {
  readonly session = { role: "cli_login_postgres", searchPath: '"$user", public' };
  readonly events: string[] = [];
  readonly setupErrorListeners: number[] = [];
  readonly dropErrorListeners: number[] = [];

  constructor(
    readonly id: number,
    private readonly failure: SetupFailure | undefined,
  ) {
    super();
  }

  query(stmt: string): Promise<void> {
    this.events.push("query");
    this.setupErrorListeners.push(this.listenerCount("error"));
    if (this.failure === "dropConnection") {
      return Promise.resolve().then(() => {
        const err = new Error("Connection terminated unexpectedly");
        this.dropErrorListeners.push(this.listenerCount("error"));
        this.emit("error", err);
        throw err;
      });
    }
    return Promise.resolve().then(() => {
      for (const part of stmt.split(";").map((s) => s.trim())) {
        if (part === "set role postgres") {
          if (this.failure === "denyRole") {
            throw new Error('permission denied to set role "postgres"');
          }
          this.session.role = "postgres";
        } else if (part === "set search_path = ''") {
          this.session.searchPath = "";
        }
      }
      this.events.push("settled");
    });
  }
}

// Runs the embedded script against in-memory pools whose new connections start with server
// defaults; `replaceConnections` hands out a fresh connection on every checkout.
const runMigraScript = (opts: { replaceConnections?: boolean; failure?: SetupFailure } = {}) =>
  Effect.suspend(() => {
    const inspections: Array<
      { side: Side; id: number; errorListeners: number } & FakeConnection["session"]
    > = [];
    const connections: FakeConnection[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ended: Side[] = [];
    const env: Record<string, string> = {
      SOURCE: "postgres://source",
      TARGET: "postgres://target",
    };

    const createClient = (
      url: string,
      options?: { pgpOptions?: { connect?: { verify?: Verify } } },
    ) => {
      const side: Side = url === env.SOURCE ? "source" : "target";
      const verify = options?.pgpOptions?.connect?.verify;
      let current: FakeConnection | undefined;
      const openConnection = (): Effect.Effect<FakeConnection, SessionSetupError> => {
        const fresh = new FakeConnection(
          connections.length + 1,
          side === "target" ? opts.failure : undefined,
        );
        connections.push(fresh);
        const setup =
          verify === undefined
            ? Effect.void
            : Effect.callback<void, SessionSetupError>((resume) =>
                verify(fresh, (err) => {
                  fresh.events.push(err === undefined ? "ready" : "failed");
                  resume(
                    err === undefined
                      ? Effect.void
                      : Effect.fail(new SessionSetupError({ message: err.message })),
                  );
                }),
              );
        return Effect.as(setup, fresh);
      };
      const checkout: Effect.Effect<FakeConnection, SessionSetupError> = Effect.suspend(() =>
        current !== undefined && !opts.replaceConnections
          ? Effect.succeed(current)
          : Effect.map(openConnection(), (fresh) => (current = fresh)),
      );
      return {
        side,
        checkout,
        end: () => {
          ended.push(side);
          return Promise.resolve();
        },
      };
    };
    type Client = ReturnType<typeof createClient>;

    const noop = () => "";
    const migration = {
      sql: "",
      set_safety: noop,
      add: noop,
      add_all_changes: noop,
      add_extension_changes: noop,
      changes: { triggers: noop, rlspolicies: noop, schemas: noop },
    };
    const Migration = {
      create: (base: Client, head: Client) =>
        Effect.runPromise(
          Effect.gen(function* () {
            for (const client of [base, head]) {
              const connection = yield* client.checkout;
              inspections.push({
                side: client.side,
                id: connection.id,
                errorListeners: connection.listenerCount("error"),
                ...connection.session,
              });
            }
            return migration;
          }),
        ),
    };
    const format = (args: unknown[]) =>
      args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ");

    const module = new Bun.Transpiler({ loader: "ts" }).transformSync(
      `export default async (createClient, Migration, Deno, console) => {\n${migraDiffScript.replaceAll(/^import .* from "npm:.*";$/gmu, "")}\n};`,
    );
    return Effect.gen(function* () {
      const script: { default: (...args: unknown[]) => Promise<void> } = yield* Effect.promise(
        () => import(`data:text/javascript;base64,${Buffer.from(module).toString("base64")}`),
      );
      yield* Effect.promise(() =>
        script.default(
          createClient,
          Migration,
          { env: { get: (key: string) => env[key] } },
          {
            log: (...args: unknown[]) => stdout.push(format(args)),
            error: (...args: unknown[]) => stderr.push(format(args)),
          },
        ),
      );
      return { inspections, connections, stdout, stderr, ended };
    });
  });

describe("embedded migra templates", () => {
  it("emit the error sentinel from the diff script's failure path", () => {
    expect(migraDiffScript).toContain(EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL);
  });

  it.effect(
    "re-apply the session settings on every replacement connection (supabase/cli#6860)",
    () =>
      Effect.gen(function* () {
        const run = yield* runMigraScript({ replaceConnections: true });

        expect(run.stderr).toEqual([]);
        expect(run.stdout).toEqual([""]);
        const sides: Side[] = ["source", "target"];
        for (const side of sides) {
          expect(
            run.inspections.filter((inspection) => inspection.side === side).length,
          ).toBeGreaterThan(1);
        }
        for (const inspection of run.inspections) {
          expect(inspection).toMatchObject({
            role: inspection.side === "target" ? "postgres" : "cli_login_postgres",
            searchPath: "",
            errorListeners: 0,
          });
        }
        for (const connection of run.connections) {
          expect(connection.events).toEqual(["query", "settled", "ready"]);
          expect(connection.setupErrorListeners).toEqual([1]);
        }
      }),
  );

  it.effect("report a failed session setup through the error sentinel", () =>
    Effect.gen(function* () {
      const run = yield* runMigraScript({ failure: "denyRole" });

      expect(run.stdout).toEqual([]);
      expect(run.stderr).toEqual([
        `set role postgres; set search_path = '': permission denied to set role "postgres"`,
        EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL,
      ]);
      expect(run.ended.toSorted()).toEqual(["source", "target"]);
    }),
  );

  it.effect("report a connection dropped during session setup through the error sentinel", () =>
    Effect.gen(function* () {
      const run = yield* runMigraScript({ failure: "dropConnection" });

      expect(run.stdout).toEqual([]);
      expect(run.stderr).toEqual([
        "set role postgres; set search_path = '': Connection terminated unexpectedly",
        EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL,
      ]);
      expect(run.ended.toSorted()).toEqual(["source", "target"]);
      const dropped = run.connections.filter(
        (connection) => connection.dropErrorListeners.length > 0,
      );
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({
        events: ["query", "failed"],
        setupErrorListeners: [1],
        dropErrorListeners: [1],
      });
      expect(dropped[0]?.listenerCount("error")).toBe(0);
    }),
  );
});

describe("embedded user-schema queries", () => {
  it.each([
    ["listSchemasSql", listSchemasSql],
    ["dropObjectsSql", dropObjectsSql],
  ])(
    "%s constrains the pg_depend anti-join to pg_namespace rows (supabase/cli#6375)",
    (_name, sql) => {
      // normalize whitespace so a cosmetic re-wrap of the join cannot fail this
      const normalized = sql.replaceAll(/\s+/gu, " ");
      const joins = normalized.match(/pd\.objid = pn\.oid/gu) ?? [];
      const constrained =
        normalized.match(
          /pd\.objid = pn\.oid and pd\.classid = 'pg_catalog\.pg_namespace'::regclass/gu,
        ) ?? [];
      expect(joins.length).toBeGreaterThan(0);
      expect(constrained).toHaveLength(joins.length);
    },
  );
});
