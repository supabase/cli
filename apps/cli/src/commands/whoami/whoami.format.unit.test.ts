import { describe, expect, it } from "vitest";

import { renderWhoamiTable } from "./whoami.format.ts";

describe("renderWhoamiTable", () => {
  it("renders the user id, username, and primary email", () => {
    const out = renderWhoamiTable({
      gotrue_id: "5a5c1690-8f6f-4b95-b76c-97b80a8868fc",
      primary_email: "identity@example.net",
      username: "cli-owner",
    });

    expect(out).toContain("USER ID");
    expect(out).toContain("USERNAME");
    expect(out).toContain("EMAIL");
    expect(out.split("\n")).toContain(
      "   5a5c1690-8f6f-4b95-b76c-97b80a8868fc | cli-owner | identity@example.net ",
    );
  });

  it("preserves literal pipe characters in profile values", () => {
    const out = renderWhoamiTable({
      gotrue_id: "id",
      primary_email: "mailbox|tag@example.com",
      username: "handle|alias",
    });

    expect(out).toContain("mailbox|tag@example.com");
    expect(out).toContain("handle|alias");
  });
});
