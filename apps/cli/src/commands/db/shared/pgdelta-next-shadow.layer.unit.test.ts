import { describe, expect, it } from "vitest";

import { allowSameDatabaseIdentityForPlanShadows } from "./pgdelta-next-shadow.layer.ts";

describe("allowSameDatabaseIdentityForPlanShadows", () => {
  it.each([
    {
      scenario: "the declarative shadow restored the migrations snapshot lineage",
      restored: true,
      migrationsLineage: "lineage-1",
      declarativeLineage: "lineage-1",
      expected: true,
    },
    {
      scenario: "both shadows warm-restored the same snapshot lineage",
      restored: true,
      migrationsLineage: "lineage-2",
      declarativeLineage: "lineage-2",
      expected: true,
    },
    {
      scenario: "the declarative shadow was cold-provisioned",
      restored: false,
      migrationsLineage: "lineage-3",
      declarativeLineage: "lineage-3",
      expected: false,
    },
    {
      scenario: "the shadows carry different or absent snapshot lineage",
      restored: true,
      migrationsLineage: "lineage-4",
      declarativeLineage: "lineage-5",
      expected: false,
    },
    {
      scenario: "neither shadow came from a snapshot",
      restored: false,
      migrationsLineage: undefined,
      declarativeLineage: undefined,
      expected: false,
    },
  ])(
    "returns $expected when $scenario",
    ({ restored, migrationsLineage, declarativeLineage, expected }) => {
      expect(
        allowSameDatabaseIdentityForPlanShadows({
          declarativeRestoredFromPgDataSnapshot: restored,
          migrationsSnapshotLineageId: migrationsLineage,
          declarativeSnapshotLineageId: declarativeLineage,
        }),
      ).toBe(expected);
    },
  );
});
