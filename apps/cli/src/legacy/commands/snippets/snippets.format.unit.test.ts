import { describe, expect, it } from "vitest";

import { escapePipe, renderSnippetsTable } from "./snippets.format.ts";

describe("escapePipe", () => {
  it("escapes a single pipe", () => {
    expect(escapePipe("a|b")).toBe("a\\|b");
  });

  it("escapes all pipes in the value", () => {
    expect(escapePipe("name|with|pipes")).toBe("name\\|with\\|pipes");
  });

  it("returns the value unchanged when there is no pipe", () => {
    expect(escapePipe("plain")).toBe("plain");
  });

  it("returns the empty string unchanged", () => {
    expect(escapePipe("")).toBe("");
  });
});

describe("renderSnippetsTable", () => {
  it("renders headers in a Glamour ASCII table", () => {
    const out = renderSnippetsTable([]);
    expect(out).toContain("ID");
    expect(out).toContain("NAME");
    expect(out).toContain("VISIBILITY");
    expect(out).toContain("OWNER");
    expect(out).toContain("CREATED AT (UTC)");
    expect(out).toContain("UPDATED AT (UTC)");
  });

  it("escapes pipes in name, visibility, and owner.username", () => {
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
    expect(out).toContain("name\\|here");
    expect(out).toContain("user\\|public");
    expect(out).toContain("user\\|name");
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
