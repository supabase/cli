import { describe, expect, it } from "vitest";
import { parseSpecifier } from "./stack-lock.ts";

describe("parseSpecifier", () => {
  it.each([
    ["linked", { kind: "linked" }],
    ["bundled", { kind: "bundled" }],
    ["v1.2.3", { kind: "release", upstream: "v1.2.3" }],
    ["v1.2.3-r4", { kind: "release", upstream: "v1.2.3", revision: 4 }],
    ["v2.197.0-r0", { kind: "release", upstream: "v2.197.0", revision: 0 }],
    ["15.1.0.000-orioledb", { kind: "release", upstream: "15.1.0.000-orioledb" }],
    ["15.1.0.000-orioledb-r12", { kind: "release", upstream: "15.1.0.000-orioledb", revision: 12 }],
  ])("reads %s", (text, expected) => {
    expect(parseSpecifier(text)).toEqual(expected);
  });
});
