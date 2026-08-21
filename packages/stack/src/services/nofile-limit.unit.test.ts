import { describe, expect, it } from "vitest";
import {
  clampNofileLimit,
  edgeRuntimeNofileUlimit,
  hardNofileLimitFromReport,
} from "./nofile-limit.ts";

const reportWithHard = (hard: number | string) => ({
  userLimits: {
    open_files: { hard },
  },
});

describe("edgeRuntimeNofileUlimit", () => {
  it("clamps Linux Docker's nofile request to a lower host hard limit", () => {
    const clamped = edgeRuntimeNofileUlimit("linux", 20000);
    expect(clamped.arg).toBe("nofile=20000:20000");
    expect(clamped.limit).toBe(20000);
    expect(clamped.clampWarning).toContain("lowered to 20000");
  });

  it("keeps the requested raise when the host does not constrain it", () => {
    expect(clampNofileLimit(undefined)).toBe(65536);
    expect(clampNofileLimit(1048576)).toBe(65536);
    expect(edgeRuntimeNofileUlimit("darwin")).toEqual({
      arg: "nofile=65536:65536",
      limit: 65536,
    });
  });

  it("ignores malformed diagnostic reports", () => {
    expect(hardNofileLimitFromReport(reportWithHard(20000))).toBe(20000);
    expect(hardNofileLimitFromReport(reportWithHard("unlimited"))).toBeUndefined();
    expect(hardNofileLimitFromReport({ userLimits: {} })).toBeUndefined();
  });
});
