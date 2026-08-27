import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import {
  declaredSqlExtensions,
  declarativeBaselinePrepStatements,
  filesForDeclarativeShadowLoad,
  imageExtensionCatchupAlreadyPresent,
  isImageExtensionCatchupSql,
  parsePostgresMajorVersion,
  prepareDeclarativeShadow,
} from "./prepare-declarative-shadow.ts";

const allImageCreates = [
  { name: "_cluster/extensions/pgjwt.sql", sql: 'CREATE EXTENSION "pgjwt";' },
  { name: "_cluster/extensions/pgcrypto.sql", sql: 'CREATE EXTENSION "pgcrypto";' },
  { name: "_cluster/extensions/uuid-ossp.sql", sql: 'CREATE EXTENSION "uuid-ossp";' },
];

describe("declarativeBaselinePrepStatements", () => {
  it("emits nothing when declarations do not recreate image defaults", () => {
    expect(declarativeBaselinePrepStatements(14, new Set())).toEqual([]);
    expect(declarativeBaselinePrepStatements(17, new Set())).toEqual([]);
  });

  it("detaches PG14 storage.objects before dropping declared uuid-ossp", () => {
    expect(declarativeBaselinePrepStatements(14, new Set(["uuid-ossp"]))).toEqual([
      "ALTER TABLE storage.objects ALTER COLUMN id DROP DEFAULT",
      'DROP EXTENSION IF EXISTS "uuid-ossp"',
    ]);
  });

  it("drops image pgjwt before a declared pgcrypto recreate", () => {
    expect(declarativeBaselinePrepStatements(14, new Set(["pgcrypto"]))).toEqual([
      "DROP EXTENSION IF EXISTS pgjwt",
      "DROP EXTENSION IF EXISTS pgcrypto",
    ]);
    expect(declarativeBaselinePrepStatements(17, new Set(["pgcrypto"]))).toEqual([
      "DROP EXTENSION IF EXISTS pgjwt",
      "DROP EXTENSION IF EXISTS pgcrypto",
    ]);
  });

  it("drops image pgjwt when migration SQL recreates it", () => {
    expect(
      declarativeBaselinePrepStatements(
        17,
        declaredSqlExtensions([{ name: "catchup.sql", sql: "create extension pgjwt;" }]),
      ),
    ).toEqual(["DROP EXTENSION IF EXISTS pgjwt"]);
  });

  it("drops declared image defaults on PG15+, pgjwt before pgcrypto", () => {
    expect(
      declarativeBaselinePrepStatements(17, new Set(["pgjwt", "pgcrypto", "uuid-ossp"])),
    ).toEqual([
      "DROP EXTENSION IF EXISTS pgjwt",
      "DROP EXTENSION IF EXISTS pgcrypto",
      'DROP EXTENSION IF EXISTS "uuid-ossp"',
    ]);
  });
});

describe("filesForDeclarativeShadowLoad", () => {
  it("restores omitted pgjwt after a pgcrypto recreate", () => {
    const files = [{ name: "public/01.sql", sql: "CREATE EXTENSION pgcrypto;" }];
    expect(filesForDeclarativeShadowLoad(files)).toEqual([
      ...files,
      {
        name: "_cli/restore-pgjwt.sql",
        sql: "CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;\n",
      },
    ]);
  });

  it("does not restore pgjwt when declarations recreate it", () => {
    expect(filesForDeclarativeShadowLoad(allImageCreates)).toEqual(allImageCreates);
  });
});

describe("isImageExtensionCatchupSql", () => {
  const aliceCatchup = `SET local check_function_bodies = off;

CREATE EXTENSION "pgjwt" SCHEMA "extensions";

COMMENT ON EXTENSION "pgjwt" IS 'JSON Web Token API for Postgresql';
`;

  it("accepts first-push image-extension catchup", () => {
    expect(isImageExtensionCatchupSql(aliceCatchup)).toBe(true);
    expect(imageExtensionCatchupAlreadyPresent(aliceCatchup, new Set(["pgjwt"]))).toBe(true);
    expect(imageExtensionCatchupAlreadyPresent(aliceCatchup, new Set())).toBe(false);
  });

  it("rejects catchup that also changes schema objects", () => {
    expect(
      isImageExtensionCatchupSql(`${aliceCatchup}\nCREATE TABLE public.todos (id int);\n`),
    ).toBe(false);
  });

  it("rejects a non-image extension", () => {
    expect(isImageExtensionCatchupSql('CREATE EXTENSION "postgis";')).toBe(false);
  });
});

describe("parsePostgresMajorVersion", () => {
  it("reads the leading major from SHOW server_version", () => {
    expect(parsePostgresMajorVersion("17.6")).toBe(17);
    expect(parsePostgresMajorVersion("14.15 (Debian)")).toBe(14);
    expect(parsePostgresMajorVersion("")).toBe(0);
  });
});

describe("prepareDeclarativeShadow", () => {
  it.live("skips the shadow when declarations omit image-default extensions", () => {
    const queries: string[] = [];
    const client = {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve({ rows: [] });
      },
    };
    return Effect.gen(function* () {
      yield* prepareDeclarativeShadow(client, [{ name: "a.sql", sql: "create table a (id int);" }]);
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
      const exit = yield* prepareDeclarativeShadow(client, [
        { name: "public/01.sql", sql: "CREATE EXTENSION pgcrypto;" },
      ]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined;
      expect(error !== undefined && "detail" in error ? String(error.detail) : "").toContain(
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
      yield* prepareDeclarativeShadow(client, allImageCreates);
      expect(queries).toEqual([
        "SHOW server_version",
        "DROP EXTENSION IF EXISTS pgjwt",
        "DROP EXTENSION IF EXISTS pgcrypto",
        'DROP EXTENSION IF EXISTS "uuid-ossp"',
      ]);
    });
  });
});
