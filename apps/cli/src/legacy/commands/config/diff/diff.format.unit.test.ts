import type { ConfigChangeSet } from "@supabase/config";
import { describe, expect, test } from "vitest";

import { legacyConfigApiScope, legacyConfigScopeLine } from "../config.format.ts";
import { legacyConfigDiffSummaryMessage, legacyRenderConfigDiffText } from "./diff.format.ts";

const EMPTY_CHANGE_SET: ConfigChangeSet = {
  changes: [],
  masked: [],
  unmanaged: [],
  counts: { update: 0, remote_only: 0, local_only: 0, total: 0 },
};

describe("legacyConfigApiScope", () => {
  test("lists record blocks the response carried, dropping non-records and empty records", () => {
    // An EMPTY block record is how a permission-truncated response most
    // plausibly reports a block it could not read — claiming it was
    // "compared" while all its keys render (not returned) would be false,
    // and with --exit-code that is a permanently red CI no file edit fixes.
    expect(
      legacyConfigApiScope({
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

describe("legacyConfigScopeLine", () => {
  test("calls out blocks the response did not return", () => {
    expect(
      legacyConfigScopeLine({
        present: ["api", "auth"],
        missing: ["database", "pooler", "realtime", "storage"],
      }),
    ).toBe("Comparison scope: api, auth (not returned: database, pooler, realtime, storage)\n");
  });

  test("an empty response scope renders (none)", () => {
    expect(
      legacyConfigScopeLine({
        present: [],
        missing: ["api", "auth", "database", "pooler", "realtime", "storage"],
      }),
    ).toBe(
      "Comparison scope: (none) (not returned: api, auth, database, pooler, realtime, storage)\n",
    );
  });
});

describe("legacyConfigDiffSummaryMessage", () => {
  test("a missing block's caveat travels with the summary message, not just the text renderer", () => {
    // Mirrors the hazard documented above: a partial API response (e.g. a
    // scoped token returning `auth: {}`) must not report an unqualified "No
    // config differences found." in machine `.message` — an agent echoing
    // just `.message` would otherwise wrongly claim a full comparison.
    expect(
      legacyConfigDiffSummaryMessage(EMPTY_CHANGE_SET, { present: ["api"], missing: ["auth"] }),
    ).toBe(
      "No config differences found. 1 block was not returned by the API and was not compared: auth.",
    );
  });

  test("multiple missing blocks pluralize the caveat", () => {
    expect(
      legacyConfigDiffSummaryMessage(EMPTY_CHANGE_SET, {
        present: [],
        missing: ["auth", "storage"],
      }),
    ).toBe(
      "No config differences found. 2 blocks were not returned by the API and were not compared: auth, storage.",
    );
  });

  test("no caveat when every block was returned", () => {
    expect(
      legacyConfigDiffSummaryMessage(EMPTY_CHANGE_SET, { present: ["api"], missing: [] }),
    ).toBe("No config differences found.");
  });

  test("the missing-block caveat travels alongside the masked/unmanaged caveats", () => {
    const changeSet: ConfigChangeSet = {
      ...EMPTY_CHANGE_SET,
      masked: [["auth", "external", "github", "secret"]],
    };
    expect(
      legacyConfigDiffSummaryMessage(changeSet, { present: ["api"], missing: ["storage"] }),
    ).toBe(
      "No config differences found. 1 block was not returned by the API and was not compared: storage. " +
        "1 credential value not compared (masked by the API): auth.external.github.secret.",
    );
  });
});

describe("legacyRenderConfigDiffText", () => {
  // Pins the exact byte shape once the per-change loop moved to
  // `legacyConfigRenderChangeLines` (`../config.format.ts`, shared with
  // `config push`): one blank line between change blocks, one blank line
  // between the last change block and the counts line, no blank line before
  // the `Note:` lines.
  test("byte-identical after the per-change renderer moved to config.format.ts", () => {
    const changeSet: ConfigChangeSet = {
      changes: [
        { path: ["api", "max_rows"], class: "update", declared: true, local: 500, remote: 1000 },
        {
          path: ["auth", "site_url"],
          class: "remote_only",
          declared: false,
          local: undefined,
          remote: "https://example.com",
        },
      ],
      masked: [["auth", "external", "github", "secret"]],
      unmanaged: [["auth", "oauth_server", "enabled"]],
      counts: { update: 1, remote_only: 1, local_only: 0, total: 2 },
    };
    expect(legacyRenderConfigDiffText(changeSet, { present: ["api", "auth"], missing: [] })).toBe(
      "api.max_rows [update]\n" +
        "  local:  500\n" +
        "  remote: 1000\n" +
        "\n" +
        "auth.site_url [remote-only]\n" +
        "  local:  (unset)\n" +
        '  remote: "https://example.com"\n' +
        "\n" +
        "2 differences found (1 update, 1 remote-only, 0 local-only).\n" +
        "Note: 1 credential value not compared (masked by the API): auth.external.github.secret\n" +
        "Note: 1 declared property cannot be pushed and was not compared: auth.oauth_server.enabled\n",
    );
  });

  test("no differences renders the empty-state line with no leading blank", () => {
    expect(
      legacyRenderConfigDiffText(
        {
          changes: [],
          masked: [],
          unmanaged: [],
          counts: { update: 0, remote_only: 0, local_only: 0, total: 0 },
        },
        { present: ["api"], missing: [] },
      ),
    ).toBe("No config differences found.\n");
  });
});
