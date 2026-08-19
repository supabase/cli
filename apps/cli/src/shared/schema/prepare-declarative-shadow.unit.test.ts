import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  declarativeBaselinePrepStatements,
  parsePostgresMajorVersion,
  prepareDeclarativeShadow,
} from "./prepare-declarative-shadow.ts";

describe("declarativeBaselinePrepStatements", () => {
  it("detaches PG14 platform dependencies before dropping implicit extensions", () => {
    expect(declarativeBaselinePrepStatements(14)).toEqual([
      "ALTER TABLE storage.objects ALTER COLUMN id DROP DEFAULT",
      "DROP EXTENSION IF EXISTS pgjwt",
      "DROP EXTENSION IF EXISTS pgcrypto",
      'DROP EXTENSION IF EXISTS "uuid-ossp"',
    ]);
  });

  it("only drops implicit extensions on PG15+", () => {
    expect(declarativeBaselinePrepStatements(17)).toEqual([
      "DROP EXTENSION IF EXISTS pgcrypto",
      'DROP EXTENSION IF EXISTS "uuid-ossp"',
    ]);
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
      yield* prepareDeclarativeShadow(client);
      expect(queries).toEqual([
        "SHOW server_version",
        "DROP EXTENSION IF EXISTS pgcrypto",
        'DROP EXTENSION IF EXISTS "uuid-ossp"',
      ]);
    });
  });
});
