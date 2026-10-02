import { describe, expect, it } from "@effect/vitest";
import { orioledbVersions, postgresMajor } from "@supabase/stack/internal/artifacts";
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

  it("routes every OrioleDB version the artifact catalog pins", () => {
    const pinned = orioledbVersions();
    expect(pinned.length).toBeGreaterThan(0);
    for (const version of pinned)
      expect(
        stackDatabaseVersion({
          major_version: Number(postgresMajor(version)),
          orioledb_version: version,
        }),
      ).toEqual(Result.succeed(`${version}-orioledb`));
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
        "db.orioledb_version = 17.6.1.000 requires a published OrioleDB artifact; supported OrioleDB versions: 17.11.0.002. A saved stack keeps its database version; switching it means recreating the stack with supabase stack destroy, which permanently deletes its local database data",
      ),
    );
    expect(
      stackDatabaseVersion({ major_version: 17, orioledb_version: "17.11.0.002" }, []),
    ).toEqual(
      Result.fail(
        "db.orioledb_version = 17.11.0.002 requires a published OrioleDB artifact; supported OrioleDB versions: none. A saved stack keeps its database version; switching it means recreating the stack with supabase stack destroy, which permanently deletes its local database data",
      ),
    );
  });
});
