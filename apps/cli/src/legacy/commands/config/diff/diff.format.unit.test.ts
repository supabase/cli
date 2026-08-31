import { describe, expect, test } from "vitest";

import { legacyConfigDiffScope, legacyConfigDiffScopeLine } from "./diff.format.ts";

describe("legacyConfigDiffScope", () => {
  test("lists record blocks the response carried, dropping non-records and empty records", () => {
    // An EMPTY block record is how a permission-truncated response most
    // plausibly reports a block it could not read — claiming it was
    // "compared" while all its keys render (not returned) would be false,
    // and with --exit-code that is a permanently red CI no file edit fixes.
    expect(
      legacyConfigDiffScope({
        api: { max_rows: 5 },
        auth: {},
        database: null,
        realtime: [1],
        storage: "nope",
      }),
    ).toEqual({
      present: ["api"],
      missing: ["auth", "database", "pooler", "realtime", "storage"],
    });
  });
});

describe("legacyConfigDiffScopeLine", () => {
  test("calls out blocks the response did not return", () => {
    expect(
      legacyConfigDiffScopeLine({
        present: ["api", "auth"],
        missing: ["database", "pooler", "realtime", "storage"],
      }),
    ).toBe("Comparison scope: api, auth (not returned: database, pooler, realtime, storage)\n");
  });

  test("an empty response scope renders (none)", () => {
    expect(
      legacyConfigDiffScopeLine({
        present: [],
        missing: ["api", "auth", "database", "pooler", "realtime", "storage"],
      }),
    ).toBe(
      "Comparison scope: (none) (not returned: api, auth, database, pooler, realtime, storage)\n",
    );
  });
});
