import { describe, expect, it } from "vitest";

import { inspectDbCommandPath } from "./db.layers.ts";

describe("inspectDbCommandPath", () => {
  it("appends a native leaf to the inspect db path", () => {
    expect(inspectDbCommandPath("locks")).toEqual(["inspect", "db", "locks"]);
    expect(inspectDbCommandPath("vacuum-stats")).toEqual(["inspect", "db", "vacuum-stats"]);
  });

  it("records a deprecated alias under its own name, not the backend command", () => {
    expect(inspectDbCommandPath("cache-hit")).toEqual(["inspect", "db", "cache-hit"]);
    expect(inspectDbCommandPath("index-usage")).toEqual(["inspect", "db", "index-usage"]);
  });
});
