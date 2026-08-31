import { describe, expect, test } from "vitest";

import { legacyConfigDiffScope, legacyConfigDiffScopeLine } from "./diff.format.ts";

describe("legacyConfigDiffScope", () => {
  test("lists record blocks the response carried, dropping non-records", () => {
    expect(
      legacyConfigDiffScope({
        api: { max_rows: 5 },
        auth: {},
        database: null,
        realtime: [1],
        storage: "nope",
      }),
    ).toEqual(["api", "auth"]);
  });
});

describe("legacyConfigDiffScopeLine", () => {
  test("calls out blocks the response did not return", () => {
    expect(legacyConfigDiffScopeLine(["api", "auth"])).toBe(
      "Comparison scope: api, auth (not returned: database, pooler, realtime, storage)\n",
    );
  });

  test("an empty response scope renders (none)", () => {
    expect(legacyConfigDiffScopeLine([])).toBe(
      "Comparison scope: (none) (not returned: api, auth, database, pooler, realtime, storage)\n",
    );
  });
});
