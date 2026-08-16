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
    // A declarative shadow restored from the migrations side's own snapshot key IS a physical
    // clone of that cluster — whether the migrations side warm-restored from the tar or
    // cold-exported it this run (the baseline handoff) — so the guard must be bypassed.
    { restored: true, sameKey: true, expected: true },
    // Restored from a DIFFERENT key's tar: a different originating cluster, own identity.
    { restored: true, sameKey: false, expected: false },
    // A freshly initdb'd declarative shadow always carries a brand-new identity.
    { restored: false, sameKey: true, expected: false },
    { restored: false, sameKey: false, expected: false },
  ])(
    "returns $expected for restored=$restored and sameKey=$sameKey",
    ({ restored, sameKey, expected }) => {
      expect(
        legacyAllowSameDatabaseIdentityForPlanShadows({
          declarativeRestoredFromPgDataSnapshot: restored,
          sameSnapshotKey: sameKey,
        }),
      ).toBe(expected);
    },
  );
});
