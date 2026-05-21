import { describe, expect, it } from "vitest";

import { renderGlamourTable } from "./legacy-glamour-table.ts";

describe("renderGlamourTable", () => {
  // Byte-for-byte parity with the Go fixture in
  // apps/cli-go/internal/backups/list/list_test.go (TestListBackup/lists PITR backup).
  it("matches the Go PITR-backup table fixture", () => {
    const out = renderGlamourTable(
      ["REGION", "WALG", "PITR", "EARLIEST TIMESTAMP", "LATEST TIMESTAMP"],
      [["Southeast Asia (Singapore)", "true", "true", "0", "0"]],
    );

    const expected =
      "\n" +
      "  \n" +
      "   REGION                     | WALG | PITR | EARLIEST TIMESTAMP | LATEST TIMESTAMP \n" +
      "  ----------------------------|------|------|--------------------|------------------\n" +
      "   Southeast Asia (Singapore) | true | true | 0                  | 0                \n" +
      "\n";

    expect(out).toBe(expected);
  });

  // Byte-for-byte parity with the Go fixture in
  // apps/cli-go/internal/backups/list/list_test.go (TestListBackup/lists WALG backup).
  it("matches the Go logical-backup table fixture", () => {
    const out = renderGlamourTable(
      ["REGION", "BACKUP TYPE", "STATUS", "CREATED AT (UTC)"],
      [["Southeast Asia (Singapore)", "PHYSICAL", "COMPLETED", "2026-02-08 16:44:07"]],
    );

    const expected =
      "\n" +
      "  \n" +
      "   REGION                     | BACKUP TYPE | STATUS    | CREATED AT (UTC)    \n" +
      "  ----------------------------|-------------|-----------|---------------------\n" +
      "   Southeast Asia (Singapore) | PHYSICAL    | COMPLETED | 2026-02-08 16:44:07 \n" +
      "\n";

    expect(out).toBe(expected);
  });
});
