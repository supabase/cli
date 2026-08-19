import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect, it as vitestIt } from "vitest";

import {
  legacyAllowSameDatabaseIdentityForPlanShadows,
  legacyPreparePgDeltaNextDeclarativeBaseline,
} from "./legacy-pgdelta-next-shadow.layer.ts";

function recordingSession() {
  const statements: string[] = [];
  return {
    statements,
    session: {
      exec: (sql: string) =>
        Effect.sync(() => {
          statements.push(sql);
        }),
    },
  };
}

describe("legacyPreparePgDeltaNextDeclarativeBaseline", () => {
  it.effect("detaches the PG14 platform dependencies before dropping extensions", () => {
    const { session, statements } = recordingSession();
    return Effect.gen(function* () {
      yield* legacyPreparePgDeltaNextDeclarativeBaseline(session, 14);
      expect(statements).toEqual([
        "ALTER TABLE storage.objects ALTER COLUMN id DROP DEFAULT",
        "DROP EXTENSION IF EXISTS pgjwt",
        "DROP EXTENSION IF EXISTS pgcrypto",
        'DROP EXTENSION IF EXISTS "uuid-ossp"',
      ]);
    });
  });

  it.effect("does not modify PG15+ platform objects before dropping extensions", () => {
    const { session, statements } = recordingSession();
    return Effect.gen(function* () {
      yield* legacyPreparePgDeltaNextDeclarativeBaseline(session, 17);
      expect(statements).toEqual([
        "DROP EXTENSION IF EXISTS pgcrypto",
        'DROP EXTENSION IF EXISTS "uuid-ossp"',
      ]);
    });
  });
});

describe("legacyAllowSameDatabaseIdentityForPlanShadows", () => {
  vitestIt.each([
    {
      // The baseline handoff on a cold cache: the migrations shadow exported the tar this very
      // run and the declarative shadow warm-restored that same key — an exact physical clone,
      // so the guard has to be bypassed even though the migrations handle is not a restore.
      scenario: "the declarative shadow restored the tar the migrations shadow just exported",
      restored: true,
      sameKey: true,
      expected: true,
    },
    {
      // Both sides warm off the same tar on a later run — same lineage, same conclusion.
      scenario: "both shadows warm-restored the same key",
      restored: true,
      sameKey: true,
      expected: true,
    },
    {
      // A freshly initdb'd declarative shadow always carries a brand-new identity, so the guard
      // stays armed no matter what the migrations side did.
      scenario: "the declarative shadow was cold-provisioned",
      restored: false,
      sameKey: true,
      expected: false,
    },
    {
      // Restored from a DIFFERENT key's tar: a different originating cluster, own identity. This
      // also covers an absent key on either side (uncached/bypassed/uncachable acquisitions),
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
      legacyAllowSameDatabaseIdentityForPlanShadows({
        declarativeRestoredFromPgDataSnapshot: restored,
        sameSnapshotKey: sameKey,
      }),
    ).toBe(expected);
  });
});
