import { describe, expect, it } from "vitest";

import { renderSecretsListTable } from "./secrets.format.ts";

describe("renderSecretsListTable", () => {
  it("produces a header-only Glamour table when there are no secrets", () => {
    expect(renderSecretsListTable([])).toBe("\n  \n   NAME | DIGEST \n  ------|--------\n\n");
  });

  it("aligns NAME and DIGEST columns for a two-row input (Go byte-parity)", () => {
    expect(
      renderSecretsListTable([
        { name: "MY_SECRET", value: "digest123" },
        { name: "OTHER", value: "digest456" },
      ]),
    ).toBe(
      "\n  \n   NAME      | DIGEST    \n" +
        "  -----------|-----------\n" +
        "   MY_SECRET | digest123 \n" +
        "   OTHER     | digest456 \n\n",
    );
  });

  it("passes literal `|` characters in names through without escaping", () => {
    // Go writes `\|` in its markdown source; Glamour decodes it back to a
    // literal pipe in the rendered cell. Going direct to the row renderer
    // produces the same byte output (verified against the Go binary).
    const out = renderSecretsListTable([{ name: "with|pipe", value: "digest456" }]);
    expect(out).toBe(
      "\n  \n   NAME      | DIGEST    \n" +
        "  -----------|-----------\n" +
        "   with|pipe | digest456 \n\n",
    );
  });
});
