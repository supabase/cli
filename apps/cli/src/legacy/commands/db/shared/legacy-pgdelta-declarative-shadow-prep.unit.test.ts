import { EventEmitter } from "node:events";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";

import {
  legacyDeclarativeBaselinePrepStatements,
  legacyDeclaredSqlExtensions,
  legacyFilesForDeclarativeShadowLoad,
  legacyParsePostgresMajorVersion,
  legacyPrepareDeclarativeShadow,
  type LegacyDeclarativeShadowClient,
} from "./legacy-pgdelta-declarative-shadow-prep.ts";
import { LegacyPgDeltaEngineError } from "./legacy-pgdelta-engine.service.ts";

const fakeShadowClient = (
  query: (sql: string) => Promise<{ readonly rows: ReadonlyArray<unknown> }>,
  onRelease?: (error?: Error | boolean) => void,
): LegacyDeclarativeShadowClient => ({
  connect: () =>
    Promise.resolve({
      query,
      release: (error?: Error | boolean) => {
        onRelease?.(error);
      },
    }),
});

const allImageCreates = [
  { name: "_cluster/extensions/pgjwt.sql", sql: 'CREATE EXTENSION "pgjwt";' },
  { name: "_cluster/extensions/pgcrypto.sql", sql: 'CREATE EXTENSION "pgcrypto";' },
  { name: "_cluster/extensions/uuid-ossp.sql", sql: 'CREATE EXTENSION "uuid-ossp";' },
];

describe("legacyDeclarativeBaselinePrepStatements", () => {
  it("emits nothing when declarations do not recreate image defaults", () => {
    expect(legacyDeclarativeBaselinePrepStatements(14, new Set())).toEqual([]);
    expect(legacyDeclarativeBaselinePrepStatements(17, new Set())).toEqual([]);
  });

  it("detaches PG14 storage.objects before dropping declared uuid-ossp", () => {
    expect(legacyDeclarativeBaselinePrepStatements(14, new Set(["uuid-ossp"]))).toEqual([
      "ALTER TABLE storage.objects ALTER COLUMN id DROP DEFAULT",
      'DROP EXTENSION IF EXISTS "uuid-ossp"',
    ]);
  });

  it("drops image pgjwt before a declared pgcrypto recreate", () => {
    expect(legacyDeclarativeBaselinePrepStatements(14, new Set(["pgcrypto"]))).toEqual([
      "DROP EXTENSION IF EXISTS pgjwt",
      "DROP EXTENSION IF EXISTS pgcrypto",
    ]);
    expect(legacyDeclarativeBaselinePrepStatements(17, new Set(["pgcrypto"]))).toEqual([
      "DROP EXTENSION IF EXISTS pgjwt",
      "DROP EXTENSION IF EXISTS pgcrypto",
    ]);
  });

  it("drops declared image defaults on PG15+, pgjwt before pgcrypto", () => {
    expect(
      legacyDeclarativeBaselinePrepStatements(17, new Set(["pgjwt", "pgcrypto", "uuid-ossp"])),
    ).toEqual([
      "DROP EXTENSION IF EXISTS pgjwt",
      "DROP EXTENSION IF EXISTS pgcrypto",
      'DROP EXTENSION IF EXISTS "uuid-ossp"',
    ]);
  });
});

describe("legacyDeclaredSqlExtensions", () => {
  it("ignores CREATE EXTENSION inside mismatched nested dollar quotes", () => {
    expect(
      legacyDeclaredSqlExtensions([
        {
          name: "fn.sql",
          sql: `CREATE FUNCTION public.demo() RETURNS void
LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM $sql$CREATE EXTENSION pgcrypto$sql$;
END;
$function$;`,
        },
      ]),
    ).toEqual(new Set());
  });

  it("ignores CREATE EXTENSION hidden by nested block comments", () => {
    expect(
      legacyDeclaredSqlExtensions([
        {
          name: "nested.sql",
          sql: "/* outer /* inner */ CREATE EXTENSION pgcrypto */",
        },
      ]),
    ).toEqual(new Set());
    expect(
      legacyDeclaredSqlExtensions([
        {
          name: "after-nested.sql",
          sql: "/* /* inner */ */ CREATE EXTENSION pgcrypto;",
        },
      ]),
    ).toEqual(new Set(["pgcrypto"]));
  });

  it("ignores CREATE EXTENSION inside double-quoted identifiers", () => {
    expect(
      legacyDeclaredSqlExtensions([
        {
          name: "quoted-table.sql",
          sql: 'CREATE TABLE "CREATE EXTENSION pgcrypto" (id int);',
        },
      ]),
    ).toEqual(new Set());
    expect(
      legacyDeclaredSqlExtensions([
        {
          name: "quoted-then-real.sql",
          sql: 'CREATE TABLE "CREATE EXTENSION pgcrypto" (id int); CREATE EXTENSION pgjwt;',
        },
      ]),
    ).toEqual(new Set(["pgjwt"]));
    expect(
      legacyDeclaredSqlExtensions([
        {
          name: "quoted-ext.sql",
          sql: 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
        },
      ]),
    ).toEqual(new Set(["uuid-ossp"]));
    expect(
      legacyDeclaredSqlExtensions([
        {
          name: "doubled-quote.sql",
          sql: 'CREATE TABLE "CREATE EXTENSION pgcrypto""x" (id int);',
        },
      ]),
    ).toEqual(new Set());
  });

  it("ignores CREATE EXTENSION inside E-string escape quotes", () => {
    expect(
      legacyDeclaredSqlExtensions([
        {
          name: "escape.sql",
          sql: "SELECT E'it\\'s CREATE EXTENSION pgcrypto';",
        },
      ]),
    ).toEqual(new Set());
    expect(
      legacyDeclaredSqlExtensions([
        {
          name: "after-escape.sql",
          sql: "SELECT E'it\\'s fine'; CREATE EXTENSION pgcrypto;",
        },
      ]),
    ).toEqual(new Set(["pgcrypto"]));
  });
});

describe("legacyFilesForDeclarativeShadowLoad", () => {
  it("restores omitted pgjwt only when prep dropped an installed image copy", () => {
    const files = [{ name: "public/01.sql", sql: "CREATE EXTENSION pgcrypto;" }];
    expect(legacyFilesForDeclarativeShadowLoad(files, false)).toEqual(files);
    expect(legacyFilesForDeclarativeShadowLoad(files, true)).toEqual([
      ...files,
      {
        name: "_cli/restore-pgjwt.sql",
        sql: "CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;\n",
      },
    ]);
  });
});

describe("legacyParsePostgresMajorVersion", () => {
  it("reads the leading major from SHOW server_version", () => {
    expect(legacyParsePostgresMajorVersion("17.6")).toBe(17);
    expect(legacyParsePostgresMajorVersion("14.15 (Debian)")).toBe(14);
    expect(legacyParsePostgresMajorVersion("")).toBe(0);
  });
});

describe("legacyPrepareDeclarativeShadow", () => {
  it.live("skips the shadow when declarations omit image-default extensions", () => {
    const queries: string[] = [];
    const client = fakeShadowClient((sql) => {
      queries.push(sql);
      return Promise.resolve({ rows: [] });
    });
    return Effect.gen(function* () {
      const prep = yield* legacyPrepareDeclarativeShadow(client, [
        { name: "a.sql", sql: "create table a (id int);" },
      ]);
      expect(prep.restorePgjwt).toBe(false);
      expect(queries).toEqual([]);
    });
  });

  it.live("names the failing prep statement", () => {
    const client = fakeShadowClient((sql) => {
      if (sql === "SHOW server_version") {
        return Promise.resolve({ rows: [{ server_version: "15.8" }] });
      }
      if (sql.includes("pgcrypto")) {
        return Promise.reject(new Error("cannot drop extension pgcrypto (SQLSTATE 2BP01)"));
      }
      return Promise.resolve({ rows: [] });
    });
    return Effect.gen(function* () {
      const exit = yield* legacyPrepareDeclarativeShadow(client, [
        { name: "public/01.sql", sql: "CREATE EXTENSION pgcrypto;" },
      ]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined;
      expect(error).toBeInstanceOf(LegacyPgDeltaEngineError);
      expect(error instanceof LegacyPgDeltaEngineError ? error.message : "").toContain(
        "DROP EXTENSION IF EXISTS pgcrypto",
      );
    });
  });

  it.live("runs the version-selected prep statements against the shadow", () => {
    const queries: string[] = [];
    const client = fakeShadowClient((sql) => {
      queries.push(sql);
      return Promise.resolve({
        rows: sql === "SHOW server_version" ? [{ server_version: "17.6" }] : [],
      });
    });
    return Effect.gen(function* () {
      const prep = yield* legacyPrepareDeclarativeShadow(client, allImageCreates);
      expect(prep.restorePgjwt).toBe(false);
      expect(queries).toEqual([
        "SHOW server_version",
        "DROP EXTENSION IF EXISTS pgjwt",
        "DROP EXTENSION IF EXISTS pgcrypto",
        'DROP EXTENSION IF EXISTS "uuid-ossp"',
      ]);
    });
  });

  it.live("restores pgjwt only when the image had it installed", () => {
    const queries: string[] = [];
    const client = fakeShadowClient((sql) => {
      queries.push(sql);
      if (sql.startsWith("SELECT extname")) {
        return Promise.resolve({ rows: [{ extname: "pgjwt" }] });
      }
      return Promise.resolve({
        rows: sql === "SHOW server_version" ? [{ server_version: "14.15" }] : [],
      });
    });
    return Effect.gen(function* () {
      const prep = yield* legacyPrepareDeclarativeShadow(client, [
        { name: "public/01.sql", sql: "CREATE EXTENSION pgcrypto;" },
      ]);
      expect(prep.restorePgjwt).toBe(true);
      expect(queries[0]).toContain("pg_extension");
    });
  });

  it.live("does not restore pgjwt on images that never installed it", () => {
    const client = fakeShadowClient((sql) =>
      Promise.resolve({
        rows: sql === "SHOW server_version" ? [{ server_version: "17.6" }] : [],
      }),
    );
    return Effect.gen(function* () {
      const prep = yield* legacyPrepareDeclarativeShadow(client, [
        { name: "public/01.sql", sql: "CREATE EXTENSION pgcrypto;" },
      ]);
      expect(prep.restorePgjwt).toBe(false);
    });
  });

  it.live("discards the in-flight shadow connection when prep is interrupted", () => {
    return Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      const released = Deferred.makeUnsafe<Error | undefined>();
      const client: LegacyDeclarativeShadowClient = {
        connect: () =>
          Promise.resolve({
            query: () => {
              Deferred.doneUnsafe(started, Effect.void);
              return new Promise<{ readonly rows: ReadonlyArray<unknown> }>(() => {});
            },
            release: (error?: Error | boolean) => {
              Deferred.doneUnsafe(
                released,
                Effect.succeed(error instanceof Error ? error : undefined),
              );
            },
          }),
      };
      const fiber = yield* legacyPrepareDeclarativeShadow(client, [
        { name: "x.sql", sql: "CREATE EXTENSION pgcrypto;" },
      ]).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const error = yield* Deferred.await(released);
      expect(error?.message).toBe("shadow prep interrupted");
    });
  });

  it.live("fails prep when the checked-out connection emits error", () => {
    return Effect.gen(function* () {
      const emitter = new EventEmitter();
      const started = Deferred.makeUnsafe<void>();
      const client: LegacyDeclarativeShadowClient = {
        connect: () =>
          Promise.resolve({
            query: () => {
              Deferred.doneUnsafe(started, Effect.void);
              return new Promise<{ readonly rows: ReadonlyArray<unknown> }>(() => {});
            },
            release: () => {},
            on: (event, listener) => {
              emitter.on(event, listener);
            },
            removeListener: (event, listener) => {
              emitter.removeListener(event, listener);
            },
          }),
      };
      const fiber = yield* legacyPrepareDeclarativeShadow(client, [
        { name: "x.sql", sql: "CREATE EXTENSION pgcrypto;" },
      ]).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      emitter.emit("error", new Error("socket hang up"));
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined;
      expect(error instanceof LegacyPgDeltaEngineError ? error.message : "").toContain(
        "socket hang up",
      );
    });
  });
});
