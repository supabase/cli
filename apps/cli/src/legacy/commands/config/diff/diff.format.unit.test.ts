import { describe, expect, test } from "vitest";

import {
  legacyConfigDiffEnvReferences,
  legacyConfigDiffRemoteBlocks,
  legacyConfigDiffScopeLine,
} from "./diff.format.ts";

describe("legacyConfigDiffRemoteBlocks", () => {
  test("keeps record blocks and drops non-record ones", () => {
    const blocks = legacyConfigDiffRemoteBlocks({
      api: { max_rows: 5 },
      auth: {},
      database: null,
      pooler: undefined,
      realtime: [1],
      storage: "nope",
    });
    expect(blocks.api).toEqual({ max_rows: 5 });
    expect(blocks.auth).toEqual({});
    expect(blocks.database).toBeUndefined();
    expect(blocks.pooler).toBeUndefined();
    expect(blocks.realtime).toBeUndefined();
    expect(blocks.storage).toBeUndefined();
  });
});

describe("legacyConfigDiffEnvReferences", () => {
  test("collects env-var names for environment origins only", () => {
    const references = legacyConfigDiffEnvReferences([
      { path: ["api", "max_rows"], source: "environment", envVariable: "PGRST_MAX_ROWS" },
      { path: ["auth", "site_url"], source: "local" },
      // An environment origin with no recorded name (pre-existing data) is skipped.
      { path: ["db", "port"], source: "environment" },
    ]);
    expect(references.get("api.max_rows")).toBe("PGRST_MAX_ROWS");
    expect(references.size).toBe(1);
  });

  test("no value origins means no references", () => {
    expect(legacyConfigDiffEnvReferences(undefined).size).toBe(0);
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
