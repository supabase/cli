import { describe, expect, it } from "vitest";
import { createFleet } from "@supabase/stack/fleet";

describe("Fleet package export", () => {
  it("is available from the Stack fleet subpath", () => {
    expect(createFleet).toBeTypeOf("function");
  });
});
