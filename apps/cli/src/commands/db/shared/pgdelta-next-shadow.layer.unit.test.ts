import { describe, expect, it } from "vitest";

import { allowSameDatabaseIdentityForPlanShadows } from "./pgdelta-next-shadow.layer.ts";

describe("allowSameDatabaseIdentityForPlanShadows", () => {
  it.each([
    {
      scenario: "the declarative shadow restored the tar the migrations shadow just exported",
      restored: true,
      sameKey: true,
      expected: true,
    },
    {
      scenario: "both shadows warm-restored the same key",
      restored: true,
      sameKey: true,
      expected: true,
    },
    {
      scenario: "the declarative shadow was cold-provisioned",
      restored: false,
      sameKey: true,
      expected: false,
    },
    {
      // Also covers an absent key on either side (uncached/bypassed/uncachable acquisitions),
      // which the caller folds into `sameSnapshotKey: false`.
      scenario: "the shadows carry different or absent snapshot keys",
      restored: true,
      sameKey: false,
      expected: false,
    },
    {
      scenario: "neither shadow came from a snapshot",
      restored: false,
      sameKey: false,
      expected: false,
    },
  ])("returns $expected when $scenario", ({ restored, sameKey, expected }) => {
    expect(
      allowSameDatabaseIdentityForPlanShadows({
        declarativeRestoredFromPgDataSnapshot: restored,
        sameSnapshotKey: sameKey,
      }),
    ).toBe(expected);
  });
});
