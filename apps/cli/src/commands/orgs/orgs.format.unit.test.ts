import { describe, expect, it } from "vitest";

import { renderOrgsListTable } from "./orgs.format.ts";

describe("renderOrgsListTable", () => {
  it("renders the header row even when the organization list is empty", () => {
    const out = renderOrgsListTable([]);
    expect(out).toContain("ID");
    expect(out).toContain("NAME");
  });

  it("renders one row per organization with id and name columns", () => {
    const out = renderOrgsListTable([
      { id: "combined-fuchsia-lion", slug: "combined-fuchsia-lion", name: "My Org" },
      { id: "calm-cobalt-emu", slug: "calm-cobalt-emu", name: "Another Org" },
    ]);
    expect(out).toContain("combined-fuchsia-lion");
    expect(out).toContain("My Org");
    expect(out).toContain("calm-cobalt-emu");
    expect(out).toContain("Another Org");
  });

  it("preserves literal `|` characters in organization names (Glamour does not double-escape)", () => {
    const out = renderOrgsListTable([{ id: "id", slug: "id", name: "with|pipe" }]);
    expect(out).toContain("with|pipe");
  });
});
