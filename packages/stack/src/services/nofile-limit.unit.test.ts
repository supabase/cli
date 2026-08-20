import { describe, expect, it } from "vitest";
import {
  clampNofileLimit,
  edgeRuntimeNofileUlimit,
  hardNofileLimitFromReport,
} from "./nofile-limit.ts";

const reportWithHard = (hard: number | string) => ({
  header: { reportVersion: 5 },
  userLimits: {
    open_files: { soft: 1024, hard },
  },
});

describe("hardNofileLimitFromReport", () => {
  it("reads the hard limit from a diagnostic report", () => {
    expect(hardNofileLimitFromReport(reportWithHard(1048576))).toBe(1048576);
    expect(hardNofileLimitFromReport(reportWithHard(20000))).toBe(20000);
  });

  it("returns undefined when the hard limit is unlimited", () => {
    expect(hardNofileLimitFromReport(reportWithHard("unlimited"))).toBeUndefined();
  });

  it("returns undefined for missing or malformed report shapes", () => {
    expect(hardNofileLimitFromReport(undefined)).toBeUndefined();
    expect(hardNofileLimitFromReport(null)).toBeUndefined();
    expect(hardNofileLimitFromReport({})).toBeUndefined();
    expect(hardNofileLimitFromReport({ userLimits: {} })).toBeUndefined();
    expect(hardNofileLimitFromReport({ userLimits: { open_files: {} } })).toBeUndefined();
    expect(hardNofileLimitFromReport(reportWithHard(-1))).toBeUndefined();
  });
});

describe("clampNofileLimit", () => {
  it("keeps the 65536 raise when the hard limit is unknown or higher", () => {
    expect(clampNofileLimit(undefined)).toBe(65536);
    expect(clampNofileLimit(1048576)).toBe(65536);
    expect(clampNofileLimit(65536)).toBe(65536);
  });

  it("clamps down to a lower hard limit (CLI-2220's 20000-cap sandbox)", () => {
    expect(clampNofileLimit(20000)).toBe(20000);
  });
});

describe("edgeRuntimeNofileUlimit", () => {
  it("keeps the full 65536 raise off Linux, where the daemon runs in a VM", () => {
    expect(edgeRuntimeNofileUlimit("darwin")).toBe("nofile=65536:65536");
    expect(edgeRuntimeNofileUlimit("win32")).toBe("nofile=65536:65536");
  });

  it("produces a matched soft:hard arg within Go's 65536 raise on Linux", () => {
    const ulimit = edgeRuntimeNofileUlimit("linux");
    const match = /^nofile=(\d+):(\d+)$/.exec(ulimit);
    expect(match).not.toBeNull();
    const [, soft, hard] = match!;
    expect(soft).toBe(hard);
    const limit = Number(soft);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(65536);
  });
});
