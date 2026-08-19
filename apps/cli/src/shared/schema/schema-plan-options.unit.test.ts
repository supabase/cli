import { describe, expect, it } from "@effect/vitest";
import { schemaIsolatedPlanOptions } from "./schema-plan-options.ts";

describe("schemaIsolatedPlanOptions", () => {
  it("uses an isolated cluster and does not seed assumed schemas", () => {
    expect(schemaIsolatedPlanOptions.isolatedShadow).toBe(true);
    expect(schemaIsolatedPlanOptions.seedAssumedSchemas).toBe(false);
    expect(schemaIsolatedPlanOptions.allowSameDatabaseIdentity).toBe(true);
    expect(schemaIsolatedPlanOptions.scope).toBe("database");
  });
});
