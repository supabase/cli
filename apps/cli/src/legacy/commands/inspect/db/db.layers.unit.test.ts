import { describe, expect, it } from "vitest";

import { legacyInspectDbCommandPath } from "./db.layers.ts";

describe("legacyInspectDbCommandPath", () => {
  // Go's inspect tree is a real 3-level cobra hierarchy, so each leaf's
  // `cmd.CommandPath()` is distinct and `cli_command_executed` records the full
  // path (apps/cli-go/cmd/root_analytics.go:32-38). The TS command-runtime path
  // must append the leaf to `["inspect", "db"]` so telemetry matches Go rather than
  // collapsing all 25 subcommands into a single `inspect db` event.
  it("appends a native leaf to the inspect db path", () => {
    expect(legacyInspectDbCommandPath("locks")).toEqual(["inspect", "db", "locks"]);
    expect(legacyInspectDbCommandPath("vacuum-stats")).toEqual(["inspect", "db", "vacuum-stats"]);
  });

  it("records a deprecated alias under its own name, not the backend command", () => {
    // `cache-hit` delegates to the db-stats backend but is its own cobra command;
    // Go's CommandPath() reflects the alias the user typed (cmd/inspect.go:139-247),
    // so the path must carry the alias, never `db-stats`.
    expect(legacyInspectDbCommandPath("cache-hit")).toEqual(["inspect", "db", "cache-hit"]);
    expect(legacyInspectDbCommandPath("index-usage")).toEqual(["inspect", "db", "index-usage"]);
  });
});
