import { describe, expect, it } from "@effect/vitest";

import { parsePostgresClientMajor } from "./postgres-client.run.ts";

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
