import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { legacyPreparePgDeltaNextDeclarativeBaseline } from "./legacy-pgdelta-next-shadow.layer.ts";

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
