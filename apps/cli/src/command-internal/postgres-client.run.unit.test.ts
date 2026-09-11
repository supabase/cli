import { describe, expect, it } from "@effect/vitest";

import { matchingHostPostgresClient, parsePostgresClientMajor } from "./postgres-client.run.ts";

describe("parsePostgresClientMajor", () => {
  it("reads the PostgreSQL major from client --version output", () => {
    expect(parsePostgresClientMajor("pg_dump (PostgreSQL) 17.4")).toBe(17);
    expect(parsePostgresClientMajor("psql (PostgreSQL) 15.12")).toBe(15);
    expect(parsePostgresClientMajor("pg_dumpall (PostgreSQL) 16.1")).toBe(16);
  });

  it("returns undefined when the version line has no PostgreSQL major", () => {
    expect(parsePostgresClientMajor("pg_prove version 3.36")).toBeUndefined();
    expect(parsePostgresClientMajor("")).toBeUndefined();
  });
});

describe("matchingHostPostgresClient", () => {
  it("accepts a matching psql when pg_dump reports another major", () => {
    expect(matchingHostPostgresClient(16, 17, 17)).toEqual({ kind: "match" });
    expect(matchingHostPostgresClient(17, 16, 17)).toEqual({ kind: "match" });
  });

  it("fails only when neither client matches", () => {
    expect(matchingHostPostgresClient(16, undefined, 17)).toEqual({
      kind: "mismatch",
      command: "pg_dump",
      actual: 16,
    });
    expect(matchingHostPostgresClient(undefined, 15, 17)).toEqual({
      kind: "mismatch",
      command: "psql",
      actual: 15,
    });
    expect(matchingHostPostgresClient(undefined, undefined, 17)).toEqual({
      kind: "mismatch",
      command: "pg_dump",
      actual: undefined,
    });
  });
});
