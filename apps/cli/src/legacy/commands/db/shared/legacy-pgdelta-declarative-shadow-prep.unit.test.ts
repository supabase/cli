import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";

import {
  legacyDeclarativeBaselinePrepStatements,
  legacyFilesForDeclarativeShadowLoad,
  legacyParsePostgresMajorVersion,
  legacyPrepareDeclarativeShadow,
} from "./legacy-pgdelta-declarative-shadow-prep.ts";
import { LegacyPgDeltaEngineError } from "./legacy-pgdelta-engine.service.ts";

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

describe("legacyFilesForDeclarativeShadowLoad", () => {
  it("restores omitted pgjwt after a pgcrypto recreate", () => {
    const files = [{ name: "public/01.sql", sql: "CREATE EXTENSION pgcrypto;" }];
    expect(legacyFilesForDeclarativeShadowLoad(files)).toEqual([
      ...files,
      {
        name: "_cli/restore-pgjwt.sql",
        sql: "CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;\n",
      },
    ]);
  });

  it("does not restore pgjwt when declarations recreate it", () => {
    expect(legacyFilesForDeclarativeShadowLoad(allImageCreates)).toEqual(allImageCreates);
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
    const client = {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve({ rows: [] });
      },
    };
    return Effect.gen(function* () {
      yield* legacyPrepareDeclarativeShadow(client, [
        { name: "a.sql", sql: "create table a (id int);" },
      ]);
      expect(queries).toEqual([]);
    });
  });

  it.live("names the failing prep statement", () => {
    const client = {
      query: (sql: string) => {
        if (sql === "SHOW server_version") {
          return Promise.resolve({ rows: [{ server_version: "15.8" }] });
        }
        if (sql.includes("pgcrypto")) {
          return Promise.reject(new Error("cannot drop extension pgcrypto (SQLSTATE 2BP01)"));
        }
        return Promise.resolve({ rows: [] });
      },
    };
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
    const client = {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve({
          rows: sql === "SHOW server_version" ? [{ server_version: "17.6" }] : [],
        });
      },
    };
    return Effect.gen(function* () {
      yield* legacyPrepareDeclarativeShadow(client, allImageCreates);
      expect(queries).toEqual([
        "SHOW server_version",
        "DROP EXTENSION IF EXISTS pgjwt",
        "DROP EXTENSION IF EXISTS pgcrypto",
        'DROP EXTENSION IF EXISTS "uuid-ossp"',
      ]);
    });
  });
});
