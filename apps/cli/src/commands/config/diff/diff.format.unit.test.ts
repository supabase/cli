import type { ConfigChangeSet } from "@supabase/config";
import { describe, expect, test } from "vitest";

import { configApiScope, configScopeLine } from "../config.format.ts";
import { configDiffSummaryMessage, renderConfigDiffText } from "./diff.format.ts";

const EMPTY_CHANGE_SET: ConfigChangeSet = {
  changes: [],
  masked: [],
  unmanaged: [],
  counts: { update: 0, remote_only: 0, local_only: 0, total: 0 },
  absencePolicy: "absent-is-hands-off",
};

describe("configApiScope", () => {
  test("lists record blocks the response carried, dropping non-records and empty records", () => {
    expect(
      configApiScope({
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

describe("configScopeLine", () => {
  test("calls out blocks the response did not return", () => {
    expect(
      configScopeLine({
        present: ["api", "auth"],
        missing: ["database", "pooler", "realtime", "storage"],
      }),
    ).toBe("Comparison scope: api, auth (not returned: database, pooler, realtime, storage)\n");
  });

  test("an empty response scope renders (none)", () => {
    expect(
      configScopeLine({
        present: [],
        missing: ["api", "auth", "database", "pooler", "realtime", "storage"],
      }),
    ).toBe(
      "Comparison scope: (none) (not returned: api, auth, database, pooler, realtime, storage)\n",
    );
  });
});

describe("configDiffSummaryMessage", () => {
  test("a missing block's caveat travels with the summary message, not just the text renderer", () => {
    expect(
      configDiffSummaryMessage(EMPTY_CHANGE_SET, { present: ["api"], missing: ["auth"] }),
    ).toBe(
      "No config differences found. 1 block was not returned by the API and was not compared: auth.",
    );
  });

  test("multiple missing blocks pluralize the caveat", () => {
    expect(
      configDiffSummaryMessage(EMPTY_CHANGE_SET, {
        present: [],
        missing: ["auth", "storage"],
      }),
    ).toBe(
      "No config differences found. 2 blocks were not returned by the API and were not compared: auth, storage.",
    );
  });

  test("no caveat when every block was returned", () => {
    expect(configDiffSummaryMessage(EMPTY_CHANGE_SET, { present: ["api"], missing: [] })).toBe(
      "No config differences found.",
    );
  });

  test("the missing-block caveat travels alongside the masked/unmanaged caveats", () => {
    const changeSet: ConfigChangeSet = {
      ...EMPTY_CHANGE_SET,
      masked: [["auth", "external", "github", "secret"]],
    };
    expect(configDiffSummaryMessage(changeSet, { present: ["api"], missing: ["storage"] })).toBe(
      "No config differences found. 1 block was not returned by the API and was not compared: storage. " +
        "1 credential value not compared (masked by the API): auth.external.github.secret.",
    );
  });
});

describe("renderConfigDiffText", () => {
  // `configRenderChangeLines` (../config.format.ts) is shared with `config push`; its blank-line
  // spacing between change blocks, the counts line, and the `Note:` lines must match here exactly.
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
      absencePolicy: "absent-is-hands-off",
    };
    expect(renderConfigDiffText(changeSet, { present: ["api", "auth"], missing: [] })).toBe(
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
        "Note: 1 declared property is not part of the current comparison and was not compared: auth.oauth_server.enabled\n",
    );
  });

  test("no differences renders the empty-state line with no leading blank", () => {
    expect(
      renderConfigDiffText(
        {
          changes: [],
          masked: [],
          unmanaged: [],
          counts: { update: 0, remote_only: 0, local_only: 0, total: 0 },
          absencePolicy: "absent-is-hands-off",
        },
        { present: ["api"], missing: [] },
      ),
    ).toBe("No config differences found.\n");
  });
});
