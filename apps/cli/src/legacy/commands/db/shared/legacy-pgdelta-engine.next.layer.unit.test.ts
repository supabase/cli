import { describe, expect, it } from "vitest";

import { legacyPgDeltaNextIsolatedShadowPlanOptions } from "./legacy-pgdelta-engine.next.layer.ts";

describe("legacyPgDeltaNextIsolatedShadowPlanOptions", () => {
  it("uses the isolated full-baseline mode shared by both declarative planner entrypoints", () => {
    expect(legacyPgDeltaNextIsolatedShadowPlanOptions).toEqual({
      isolatedShadow: true,
      seedAssumedSchemas: false,
    });
  });
});
