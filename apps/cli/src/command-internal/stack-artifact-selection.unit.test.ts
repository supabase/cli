import { describe, expect, it } from "@effect/vitest";
import { orioledbVersions, postgresMajor } from "@supabase/stack/internal/artifacts";
import { Effect } from "effect";

import { stackArtifactSelection } from "./stack-artifact-selection.ts";

const published = ["17.11.0.002"];

describe("stackArtifactSelection", () => {
  it.effect("selects the major's default database pin when OrioleDB is unset or empty", () =>
    Effect.gen(function* () {
      const seventeen = yield* stackArtifactSelection({ major_version: 17 }, published);
      const fifteen = yield* stackArtifactSelection(
        { major_version: 15, orioledb_version: "" },
        published,
      );
      expect(postgresMajor(seventeen.database.upstreamVersion)).toBe("17");
      expect(fifteen.database.upstreamVersion).toMatch(/^15\./);
      expect(fifteen.rest).toEqual(seventeen.rest);
    }),
  );

  it.effect("selects every OrioleDB build the artifact catalog pins", () =>
    Effect.gen(function* () {
      const pinned = orioledbVersions();
      expect(pinned.length).toBeGreaterThan(0);
      for (const version of pinned) {
        const selection = yield* stackArtifactSelection({
          major_version: Number(postgresMajor(version)),
          orioledb_version: version,
        });
        expect(selection.database.upstreamVersion).toBe(`${version}-orioledb`);
      }
    }),
  );

  it.effect("rejects an OrioleDB version whose major differs from db.major_version", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        stackArtifactSelection({ major_version: 15, orioledb_version: "17.11.0.002" }, published),
      );
      expect(error.message).toBe(
        "db.orioledb_version (or SUPABASE_DB_ORIOLEDB_VERSION) = 17.11.0.002 requires db.major_version (or SUPABASE_DB_MAJOR_VERSION) = 17 for the experimental stack",
      );
    }),
  );

  it.effect("fails closed on an unpublished OrioleDB version, listing the published ones", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        stackArtifactSelection({ major_version: 17, orioledb_version: "17.6.1.000" }, published),
      );
      expect(error.message).toBe(
        "db.orioledb_version (or SUPABASE_DB_ORIOLEDB_VERSION) = 17.6.1.000 is not an OrioleDB build this CLI ships for the experimental stack; it ships: 17.11.0.002. A stack keeps the build it was created with, so moving an existing stack to another build means recreating it with supabase stack destroy, which permanently deletes its local database data",
      );
    }),
  );
});
