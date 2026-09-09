import { describe, expect, it } from "vitest";

import { inspectDbCommandPath } from "./db.layers.ts";

describe("inspectDbCommandPath", () => {
  // The inspect tree is a real 3-level hierarchy, so each leaf's own name is
  // distinct and `cli_command_executed` records the full path. The command-runtime
  // path must append the leaf to `["inspect", "db"]` rather than
  // collapsing all 25 subcommands into a single `inspect db` event.
  it("appends a native leaf to the inspect db path", () => {
    expect(inspectDbCommandPath("locks")).toEqual(["inspect", "db", "locks"]);
    expect(inspectDbCommandPath("vacuum-stats")).toEqual(["inspect", "db", "vacuum-stats"]);
  });

  it("records a deprecated alias under its own name, not the backend command", () => {
    // `cache-hit` delegates to the db-stats backend but is its own command;
    // the recorded path reflects the alias the user typed, so the path must
    // carry the alias, never `db-stats`.
    expect(inspectDbCommandPath("cache-hit")).toEqual(["inspect", "db", "cache-hit"]);
    expect(inspectDbCommandPath("index-usage")).toEqual(["inspect", "db", "index-usage"]);
  });
});
