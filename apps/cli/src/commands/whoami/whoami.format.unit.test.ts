import { describe, expect, it } from "vitest";

import { renderWhoamiTable } from "./whoami.format.ts";

describe("renderWhoamiTable", () => {
  it("renders the user id, username, and primary email", () => {
    const out = renderWhoamiTable({
      gotrue_id: "5a5c1690-8f6f-4b95-b76c-97b80a8868fc",
      primary_email: "person@example.com",
      username: "person",
    });

    expect(out).toContain("USER ID");
    expect(out).toContain("USERNAME");
    expect(out).toContain("EMAIL");
    expect(out).toContain("5a5c1690-8f6f-4b95-b76c-97b80a8868fc");
    expect(out).toContain("person@example.com");
    expect(out).toContain("person");
  });

  it("preserves literal pipe characters in profile values", () => {
    const out = renderWhoamiTable({
      gotrue_id: "id",
      primary_email: "person|tag@example.com",
      username: "person|tag",
    });

    expect(out).toContain("person|tag@example.com");
    expect(out).toContain("person|tag");
  });
});
