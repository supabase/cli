import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { stackDatabaseVersion } from "./stack-database-version.ts";

const published = ["17.11.0.002"];

describe("stackDatabaseVersion", () => {
  it("runs the configured major alias when OrioleDB is unset or empty", () => {
    expect(stackDatabaseVersion({ major_version: 17 }, published)).toEqual(Result.succeed("17"));
    expect(stackDatabaseVersion({ major_version: 15, orioledb_version: "" }, published)).toEqual(
      Result.succeed("15"),
    );
  });

  it("routes a published db.orioledb_version to its OrioleDB artifact", () => {
    expect(
      stackDatabaseVersion({ major_version: 17, orioledb_version: "17.11.0.002" }, published),
    ).toEqual(Result.succeed("17.11.0.002-orioledb"));
  });

  it("rejects an OrioleDB version whose major differs from db.major_version", () => {
    expect(
      stackDatabaseVersion({ major_version: 15, orioledb_version: "17.11.0.002" }, published),
    ).toEqual(
      Result.fail(
        "db.orioledb_version = 17.11.0.002 requires db.major_version = 17 for the experimental stack",
      ),
    );
  });

  it("fails closed on an unpublished OrioleDB version, listing the published ones", () => {
    expect(
      stackDatabaseVersion({ major_version: 17, orioledb_version: "17.6.1.000" }, published),
    ).toEqual(
      Result.fail(
        "db.orioledb_version = 17.6.1.000 requires a published OrioleDB artifact; supported OrioleDB versions: 17.11.0.002. A saved stack keeps its database version, so switching versions requires supabase stack destroy to recreate the stack",
      ),
    );
    expect(
      stackDatabaseVersion({ major_version: 17, orioledb_version: "17.11.0.002" }, []),
    ).toEqual(
      Result.fail(
        "db.orioledb_version = 17.11.0.002 requires a published OrioleDB artifact; supported OrioleDB versions: none. A saved stack keeps its database version, so switching versions requires supabase stack destroy to recreate the stack",
      ),
    );
  });
});
