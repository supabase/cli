import { describe, expect, it } from "vitest";
import { FLEET_PACKAGE } from "./index.ts";

describe("fleet scaffold", () => {
  it("exports the package marker", () => {
    expect(FLEET_PACKAGE).toBe("@supabase/fleet");
  });
});
