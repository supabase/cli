import { describe, expect, it } from "vitest";

import { renderSnippetsTable } from "./snippets.format.ts";

describe("renderSnippetsTable", () => {
  it("renders headers in a Glamour ASCII table when the list is empty", () => {
    const out = renderSnippetsTable([]);
    expect(out).toContain("ID");
    expect(out).toContain("NAME");
    expect(out).toContain("VISIBILITY");
    expect(out).toContain("OWNER");
    expect(out).toContain("CREATED AT (UTC)");
    expect(out).toContain("UPDATED AT (UTC)");
  });

  it("preserves literal `|` characters in name, visibility, and owner (Glamour decodes Go's escape back)", () => {
    const out = renderSnippetsTable([
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "name|here",
        visibility: "user|public",
        owner: { username: "user|name" },
        inserted_at: "2023-10-13T17:48:58.491Z",
        updated_at: "2023-10-13T17:48:58.491Z",
      },
    ]);
    expect(out).toContain("name|here");
    expect(out).toContain("user|public");
    expect(out).toContain("user|name");
    // No `\|` escape — Go's `strings.ReplaceAll` is a markdown intermediate
    // that glamour decodes; the final bytes carry the raw `|`.
    expect(out).not.toContain("\\|");
  });

  it("formats RFC3339 timestamps as UTC YYYY-MM-DD HH:MM:SS", () => {
    const out = renderSnippetsTable([
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "n",
        visibility: "user",
        owner: { username: "u" },
        inserted_at: "2023-10-13T17:48:58.491Z",
        updated_at: "2023-10-13T17:48:58.491Z",
      },
    ]);
    expect(out).toContain("2023-10-13 17:48:58");
  });
});
