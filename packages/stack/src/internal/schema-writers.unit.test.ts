import { expect, it } from "@effect/vitest";
import { compareUpstreamVersions } from "./schema-writers.ts";

it("orders each catalog version format by its leading dotted number", () => {
  const ascending = [
    ["v2.196.0", "v2.197.0"],
    ["v2.9.0", "v2.10.0"],
    ["2026.10.05-sha-aaaaaaa", "2026.10.12-sha-bbbbbbb"],
    ["17.6.1.054", "17.11.0.004"],
    ["0.58.0", "v0.100.0"],
    ["v1.30", "v1.30.1"],
    ["unversioned", "v0.0.1"],
  ] as const;
  for (const [older, newer] of ascending) {
    expect(compareUpstreamVersions(older, newer), `${older} < ${newer}`).toBe(-1);
    expect(compareUpstreamVersions(newer, older), `${newer} > ${older}`).toBe(1);
  }
});

it("treats versions that differ only by suffix or a v prefix as the same", () => {
  expect(compareUpstreamVersions("2026.10.12-sha-aaaaaaa", "2026.10.12-sha-bbbbbbb")).toBe(0);
  expect(compareUpstreamVersions("v2.197.0", "2.197.0")).toBe(0);
  expect(compareUpstreamVersions("v1.30", "v1.30.0")).toBe(0);
  expect(compareUpstreamVersions("unversioned", "other")).toBe(0);
});
