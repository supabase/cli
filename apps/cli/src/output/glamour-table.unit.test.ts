import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderGlamourTable } from "./glamour-table.ts";

describe("renderGlamourTable", () => {
  it("matches the PITR-backup table fixture", () => {
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

  it("matches the logical-backup table fixture", () => {
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

describe("renderGlamourTable on a terminal", () => {
  const terminal = { isTTY: true, hasColors: () => true };

  beforeEach(() => {
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("CLICOLOR", "");
    vi.stubEnv("CLICOLOR_FORCE", "");
    vi.stubEnv("CI", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("drops the borders, mutes the header and indents rows two spaces", () => {
    const out = renderGlamourTable(
      ["ID", "NAME"],
      [
        ["supabase", "Supabase"],
        ["conservative-purple-3w52ch0", "Supabase Dev"],
      ],
      terminal,
    );

    expect(out).toBe(
      "  \u001b[90mID                            NAME\u001b[39m\n" +
        "  supabase                      Supabase\n" +
        "  conservative-purple-3w52ch0   Supabase Dev\n" +
        "\n",
    );
  });

  it("keeps the layout without colour", () => {
    vi.stubEnv("NO_COLOR", "1");

    const out = renderGlamourTable(["ID", "NAME"], [["supabase", "Supabase"]], terminal);

    expect(out).toBe("  ID         NAME\n  supabase   Supabase\n\n");
  });

  it("sizes columns by visible width when cells carry colour", () => {
    const out = renderGlamourTable(["NAME", "STATUS"], [["\u001b[32mweb\u001b[39m", "ok"]], {
      isTTY: true,
    });

    expect(out).toBe("  NAME   STATUS\n  \u001b[32mweb\u001b[39m    ok\n\n");
  });
});
