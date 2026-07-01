import { describe, expect, it } from "vitest";

import { renderGlamourTable } from "../../../output/legacy-glamour-table.ts";
import { legacyMakeMigrationListRows, legacyMigrationListTableCells } from "./list.format.ts";

describe("legacyMakeMigrationListRows", () => {
  it("tabulates short numeric versions in chronological order (Go TestMakeTable)", () => {
    // makeTable(["0","2"], ["0","1"]) — passthrough time for non-timestamp versions.
    expect(legacyMakeMigrationListRows(["0", "2"], ["0", "1"])).toEqual([
      { local: "0", remote: "0", time: "0" },
      { local: "1", remote: "", time: "1" },
      { local: "", remote: "2", time: "2" },
    ]);
  });

  it("tabulates real timestamps with a humanised time column", () => {
    expect(
      legacyMakeMigrationListRows(
        ["20220727064246", "20220727064248"],
        ["20220727064246", "20220727064247"],
      ),
    ).toEqual([
      { local: "20220727064246", remote: "20220727064246", time: "2022-07-27 06:42:46" },
      { local: "20220727064247", remote: "", time: "2022-07-27 06:42:47" },
      { local: "", remote: "20220727064248", time: "2022-07-27 06:42:48" },
    ]);
  });

  it("skips non-numeric versions on both sides", () => {
    expect(legacyMakeMigrationListRows(["a", "c"], ["a", "b"])).toEqual([]);
  });

  it("renders local-only and remote-only rows when one side is empty", () => {
    expect(legacyMakeMigrationListRows([], ["20240101000000"])).toEqual([
      { local: "20240101000000", remote: "", time: "2024-01-01 00:00:00" },
    ]);
    expect(legacyMakeMigrationListRows(["20240101000000"], [])).toEqual([
      { local: "", remote: "20240101000000", time: "2024-01-01 00:00:00" },
    ]);
  });
});

describe("legacyMigrationListTableCells", () => {
  it("wraps present cells in backticks and absent cells in a backtick-space-backtick", () => {
    const cells = legacyMigrationListTableCells([
      { local: "20240101000000", remote: "", time: "2024-01-01 00:00:00" },
    ]);
    expect(cells).toEqual([["`20240101000000`", "` `", "`2024-01-01 00:00:00`"]]);
  });

  it("produces a Glamour table whose body matches Go's `migration list` rendering", () => {
    const rows = legacyMakeMigrationListRows(["20220727064248"], ["20220727064247"]);
    const out = renderGlamourTable(
      ["Local", "Remote", "Time (UTC)"],
      legacyMigrationListTableCells(rows),
    );
    // Backtick-wrapped inline code is preserved by AsciiStyle.
    expect(out).toContain("` `");
    expect(out).toContain("`20220727064247`");
    expect(out).toContain("`20220727064248`");
    expect(out).toContain("Local");
    expect(out).toContain("Time (UTC)");
  });
});
