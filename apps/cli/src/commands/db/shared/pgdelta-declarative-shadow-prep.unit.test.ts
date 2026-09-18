import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";

import {
  declaredSqlExtensions,
  filesForDeclarativeShadowLoad,
  prepareDeclarativeShadow,
  type DeclarativeShadowClient,
} from "./pgdelta-declarative-shadow-prep.ts";
import { PgDeltaEngineError } from "./pgdelta-engine.service.ts";

const fakeShadowClient = (
  query: (sql: string) => Promise<{ readonly rows: ReadonlyArray<unknown> }>,
): DeclarativeShadowClient => ({ query });

const allImageCreates = [
  { name: "_cluster/extensions/pgjwt.sql", sql: 'CREATE EXTENSION "pgjwt";' },
  { name: "_cluster/extensions/pgcrypto.sql", sql: 'CREATE EXTENSION "pgcrypto";' },
  { name: "_cluster/extensions/uuid-ossp.sql", sql: 'CREATE EXTENSION "uuid-ossp";' },
];

describe("declaredSqlExtensions", () => {
  it("ignores CREATE EXTENSION in comments and simple strings", () => {
    expect(
      declaredSqlExtensions([
        {
          name: "commented.sql",
          sql: "-- CREATE EXTENSION pgcrypto;\n/* CREATE EXTENSION pgjwt */\nselect 'create extension uuid-ossp';",
        },
      ]),
    ).toEqual(new Set());
    expect(
      declaredSqlExtensions([
        {
          name: "real.sql",
          sql: '-- skip me\nCREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
        },
      ]),
    ).toEqual(new Set(["uuid-ossp"]));
  });
});

describe("filesForDeclarativeShadowLoad", () => {
  it("restores omitted pgjwt only when prep dropped an installed image copy", () => {
    const files = [{ name: "public/01.sql", sql: "CREATE EXTENSION pgcrypto;" }];
    expect(filesForDeclarativeShadowLoad(files, false)).toEqual(files);
    expect(filesForDeclarativeShadowLoad(files, true)).toEqual([
      ...files,
      {
        name: "_cli/restore-pgjwt.sql",
        sql: "CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;\n",
      },
    ]);
  });
});

describe("prepareDeclarativeShadow", () => {
  it.live("skips the shadow when declarations omit image-default extensions", () => {
    const queries: string[] = [];
    const client = fakeShadowClient((sql) => {
      queries.push(sql);
      return Promise.resolve({ rows: [] });
    });
    return Effect.gen(function* () {
      const prep = yield* prepareDeclarativeShadow(client, [
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
      const exit = yield* prepareDeclarativeShadow(client, [
        { name: "public/01.sql", sql: "CREATE EXTENSION pgcrypto;" },
      ]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined;
      expect(error).toBeInstanceOf(PgDeltaEngineError);
      expect(error instanceof PgDeltaEngineError ? error.message : "").toContain(
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
      const prep = yield* prepareDeclarativeShadow(client, allImageCreates);
      expect(prep.restorePgjwt).toBe(false);
      expect(queries).toEqual([
        "SHOW server_version",
        "DROP EXTENSION IF EXISTS pgjwt",
        "DROP EXTENSION IF EXISTS pgcrypto",
        'DROP EXTENSION IF EXISTS "uuid-ossp"',
      ]);
    });
  });

  it.live("detaches PG14 storage.objects before dropping declared uuid-ossp", () => {
    const queries: string[] = [];
    const client = fakeShadowClient((sql) => {
      queries.push(sql);
      return Promise.resolve({
        rows: sql === "SHOW server_version" ? [{ server_version: "14.15" }] : [],
      });
    });
    return Effect.gen(function* () {
      yield* prepareDeclarativeShadow(client, [
        { name: "uuid.sql", sql: 'CREATE EXTENSION "uuid-ossp";' },
      ]);
      expect(queries).toEqual([
        "SHOW server_version",
        "ALTER TABLE storage.objects ALTER COLUMN id DROP DEFAULT",
        'DROP EXTENSION IF EXISTS "uuid-ossp"',
      ]);
    });
  });

  it.live("restores pgjwt only when the image had it installed", () => {
    const queries: string[] = [];
    const withPgjwt = fakeShadowClient((sql) => {
      queries.push(sql);
      if (sql.startsWith("SELECT extname")) {
        return Promise.resolve({ rows: [{ extname: "pgjwt" }] });
      }
      return Promise.resolve({
        rows: sql === "SHOW server_version" ? [{ server_version: "17.6" }] : [],
      });
    });
    const withoutPgjwt = fakeShadowClient((sql) =>
      Promise.resolve({
        rows: sql === "SHOW server_version" ? [{ server_version: "17.6" }] : [],
      }),
    );
    const files = [{ name: "public/01.sql", sql: "CREATE EXTENSION pgcrypto;" }];
    return Effect.gen(function* () {
      expect((yield* prepareDeclarativeShadow(withPgjwt, files)).restorePgjwt).toBe(true);
      expect(queries).toEqual([
        "SELECT extname FROM pg_extension WHERE extname = 'pgjwt'",
        "SHOW server_version",
        "DROP EXTENSION IF EXISTS pgjwt",
        "DROP EXTENSION IF EXISTS pgcrypto",
      ]);
      expect((yield* prepareDeclarativeShadow(withoutPgjwt, files)).restorePgjwt).toBe(false);
    });
  });
});
