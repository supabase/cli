import { describe, expect, it } from "vitest";
import { generateBeamReleaseCookie } from "./BeamCookie.ts";

describe("generateBeamReleaseCookie", () => {
  it("produces a random cookie that fits every native consumer's identifier limits", () => {
    const cookie = generateBeamReleaseCookie();

    expect(cookie).toMatch(/^supabase_[a-f0-9]{46}_cookie$/);
    expect(Buffer.byteLength(cookie, "utf8")).toBeLessThanOrEqual(63);
    expect(generateBeamReleaseCookie()).not.toBe(cookie);
  });
});
