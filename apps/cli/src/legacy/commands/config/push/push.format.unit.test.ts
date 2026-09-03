import type { ConfigChange } from "@supabase/config/internal";
import { describe, expect, test } from "vitest";

import {
  legacyPushNotes,
  legacyPushPayload,
  legacyPushUpdatingLine,
  legacyPushUpToDateLine,
  type LegacyPushResource,
  type LegacyPushSecretDecision,
} from "./push.format.ts";

const API_MAX_ROWS_CHANGE: ConfigChange = {
  path: ["api", "max_rows"],
  class: "update",
  declared: true,
  local: 2000,
  remote: 1000,
};

const SENT_SECRET: LegacyPushSecretDecision = {
  path: ["auth", "captcha", "secret"],
  apiKey: "security_captcha_secret",
  status: "send",
  plaintext: "s3cr3t",
};

const UNCHANGED_SECRET: LegacyPushSecretDecision = {
  path: ["auth", "hook", "mfa_verification_attempt", "secrets"],
  apiKey: "hook_mfa_verification_attempt_secrets",
  status: "unchanged",
};

const NOT_SET_SECRET: LegacyPushSecretDecision = {
  path: ["auth", "sms", "twilio", "auth_token"],
  apiKey: "sms_twilio_auth_token",
  status: "not_set",
};

const GATED_SECRET: LegacyPushSecretDecision = {
  path: ["auth", "hook", "send_sms", "secrets"],
  apiKey: "hook_send_sms_secrets",
  status: "gated",
};

describe("legacyPushUpdatingLine", () => {
  const RESOURCE_PREFIXES: ReadonlyArray<readonly [LegacyPushResource, string]> = [
    ["api", "Updating API service with config:"],
    ["db.settings", "Updating DB service with config:"],
    ["db.network_restrictions", "Updating network restrictions with config:"],
    ["db.ssl_enforcement", "Updating SSL enforcement with config:"],
    ["auth", "Updating Auth service with config:"],
    ["storage", "Updating Storage service with config:"],
  ];

  test.each(RESOURCE_PREFIXES)("uses the established prefix for %s", (resource, prefix) => {
    expect(legacyPushUpdatingLine(resource, [API_MAX_ROWS_CHANGE], [])).toBe(
      `${prefix}\napi.max_rows [update]\n  local:  2000\n  remote: 1000\n`,
    );
  });

  test("appends a [secret] block for a status: send secret, directly after the change lines", () => {
    expect(legacyPushUpdatingLine("auth", [API_MAX_ROWS_CHANGE], [SENT_SECRET])).toBe(
      "Updating Auth service with config:\n" +
        "api.max_rows [update]\n" +
        "  local:  2000\n" +
        "  remote: 1000\n" +
        "auth.captcha.secret [secret]\n" +
        "  local:  (set; differs from the remote digest)\n" +
        "  remote: (digest)\n",
    );
  });

  test("never renders the secret plaintext or the digest itself", () => {
    const rendered = legacyPushUpdatingLine("auth", [], [SENT_SECRET]);
    expect(rendered).not.toContain("s3cr3t");
  });

  test("omits unchanged, not_set, and gated secrets from the block", () => {
    expect(
      legacyPushUpdatingLine("auth", [], [UNCHANGED_SECRET, NOT_SET_SECRET, GATED_SECRET]),
    ).toBe("Updating Auth service with config:\n");
  });

  test("renders only [secret] blocks with a blank line between multiple secrets", () => {
    const secondSecret: LegacyPushSecretDecision = {
      ...SENT_SECRET,
      path: ["auth", "external", "github", "secret"],
    };
    expect(legacyPushUpdatingLine("auth", [], [SENT_SECRET, secondSecret])).toBe(
      "Updating Auth service with config:\n" +
        "auth.captcha.secret [secret]\n" +
        "  local:  (set; differs from the remote digest)\n" +
        "  remote: (digest)\n" +
        "\n" +
        "auth.external.github.secret [secret]\n" +
        "  local:  (set; differs from the remote digest)\n" +
        "  remote: (digest)\n",
    );
  });

  test("sanitizes a hostile change path so it cannot inject ANSI or forge output lines", () => {
    const esc = String.fromCharCode(27);
    const hostile: ConfigChange = {
      path: ["auth", "sms", "test_otp", `evil${esc}[31mred\nNo config differences found.`],
      class: "update",
      declared: true,
      local: "1234",
      remote: undefined,
    };
    const rendered = legacyPushUpdatingLine("auth", [hostile], []);
    expect(rendered).not.toContain(esc);
    expect(rendered).toContain(
      "auth.sms.test_otp.evil[31mred No config differences found. [update]",
    );
  });
});

describe("legacyPushUpToDateLine", () => {
  test.each([
    ["api", "Remote API config is up to date.\n"],
    ["db.settings", "Remote DB config is up to date.\n"],
    ["db.network_restrictions", "Remote DB Network restrictions config is up to date.\n"],
    ["db.ssl_enforcement", "Remote DB SSL enforcement config is up to date.\n"],
    ["auth", "Remote Auth config is up to date.\n"],
    ["storage", "Remote Storage config is up to date.\n"],
  ] as const)("uses the established up-to-date line for %s", (resource, line) => {
    expect(legacyPushUpToDateLine(resource)).toBe(line);
  });
});

const EMPTY_NOTES = { unsupported: [], unmanaged: [], secretsNotSet: [], remoteOnly: 0 };

describe("legacyPushNotes", () => {
  test('returns "" when there is nothing to note', () => {
    expect(legacyPushNotes(EMPTY_NOTES)).toBe("");
  });

  test("unsupported: singular and plural", () => {
    expect(legacyPushNotes({ ...EMPTY_NOTES, unsupported: [["db", "major_version"]] })).toBe(
      "Note: 1 declared property cannot be pushed by config push: db.major_version\n",
    );
    expect(
      legacyPushNotes({
        ...EMPTY_NOTES,
        unsupported: [
          ["db", "pooler", "pool_mode"],
          ["db", "major_version"],
        ],
      }),
    ).toBe(
      "Note: 2 declared properties cannot be pushed by config push: db.pooler.pool_mode, db.major_version\n",
    );
  });

  test("unmanaged delegates to legacyConfigDiffUnmanagedCaveat's exact wording", () => {
    expect(
      legacyPushNotes({ ...EMPTY_NOTES, unmanaged: [["auth", "oauth_server", "enabled"]] }),
    ).toBe(
      "Note: 1 declared property cannot be pushed and was not compared: auth.oauth_server.enabled\n",
    );
  });

  test("secretsNotSet: singular and plural", () => {
    expect(
      legacyPushNotes({ ...EMPTY_NOTES, secretsNotSet: [["auth", "captcha", "secret"]] }),
    ).toBe(
      "Note: 1 credential value was not pushed (empty or unresolved env reference): auth.captcha.secret\n",
    );
    expect(
      legacyPushNotes({
        ...EMPTY_NOTES,
        secretsNotSet: [
          ["auth", "captcha", "secret"],
          ["auth", "sms", "twilio", "auth_token"],
        ],
      }),
    ).toBe(
      "Note: 2 credential values were not pushed (empty or unresolved env reference): auth.captcha.secret, auth.sms.twilio.auth_token\n",
    );
  });

  test("remoteOnly: singular and plural", () => {
    expect(legacyPushNotes({ ...EMPTY_NOTES, remoteOnly: 1 })).toBe(
      "Note: 1 remote property is not declared in supabase/config.toml and was left unchanged (run `supabase config diff` to inspect).\n",
    );
    expect(legacyPushNotes({ ...EMPTY_NOTES, remoteOnly: 12 })).toBe(
      "Note: 12 remote properties are not declared in supabase/config.toml and were left unchanged (run `supabase config diff` to inspect).\n",
    );
  });

  test("combines every present category in the established order", () => {
    expect(
      legacyPushNotes({
        unsupported: [
          ["db", "pooler", "pool_mode"],
          ["db", "major_version"],
        ],
        unmanaged: [["auth", "oauth_server", "enabled"]],
        secretsNotSet: [["auth", "captcha", "secret"]],
        remoteOnly: 12,
      }),
    ).toBe(
      "Note: 2 declared properties cannot be pushed by config push: db.pooler.pool_mode, db.major_version\n" +
        "Note: 1 declared property cannot be pushed and was not compared: auth.oauth_server.enabled\n" +
        "Note: 1 credential value was not pushed (empty or unresolved env reference): auth.captcha.secret\n" +
        "Note: 12 remote properties are not declared in supabase/config.toml and were left unchanged (run `supabase config diff` to inspect).\n",
    );
  });

  test("sanitizes a hostile path so it cannot inject ANSI or forge output lines", () => {
    const esc = String.fromCharCode(27);
    const rendered = legacyPushNotes({
      ...EMPTY_NOTES,
      unsupported: [["db", `evil${esc}[31mred\nNo config differences found.`]],
    });
    expect(rendered).not.toContain(esc);
    expect(rendered).toBe(
      "Note: 1 declared property cannot be pushed by config push: db.evil[31mred No config differences found.\n",
    );
  });
});

describe("legacyPushPayload", () => {
  const BASE_INPUT = {
    projectRef: "abcdefghijklmnopqrst",
    services: [{ service: "api", status: "updated", changes: [["api", "max_rows"]] }],
    unsupported: [["db", "pooler", "pool_mode"]],
    unmanaged: [["auth", "oauth_server", "enabled"]],
    secrets: [SENT_SECRET, UNCHANGED_SECRET, NOT_SET_SECRET, GATED_SECRET],
    remoteOnly: 12,
    scope: { present: ["api", "auth", "database", "pooler", "realtime", "storage"], missing: [] },
  };

  test("shapes the full payload, bucketing secrets by status and dropping gated decisions", () => {
    expect(legacyPushPayload(BASE_INPUT)).toEqual({
      project_ref: "abcdefghijklmnopqrst",
      services: [{ service: "api", status: "updated", changes: [["api", "max_rows"]] }],
      unsupported: [["db", "pooler", "pool_mode"]],
      unmanaged: [["auth", "oauth_server", "enabled"]],
      secrets: {
        sent: [["auth", "captcha", "secret"]],
        unchanged: [["auth", "hook", "mfa_verification_attempt", "secrets"]],
        not_sent: [["auth", "sms", "twilio", "auth_token"]],
      },
      remote_only: 12,
      scope: { present: ["api", "auth", "database", "pooler", "realtime", "storage"], missing: [] },
    });
  });

  test("empty arrays round-trip as empty arrays, not omitted keys", () => {
    expect(
      legacyPushPayload({
        projectRef: "abcdefghijklmnopqrst",
        services: [],
        unsupported: [],
        unmanaged: [],
        secrets: [],
        remoteOnly: 0,
        scope: { present: [], missing: [] },
      }),
    ).toEqual({
      project_ref: "abcdefghijklmnopqrst",
      services: [],
      unsupported: [],
      unmanaged: [],
      secrets: { sent: [], unchanged: [], not_sent: [] },
      remote_only: 0,
      scope: { present: [], missing: [] },
    });
  });

  test("does not sanitize path segments — JSON.stringify escapes control characters instead", () => {
    const esc = String.fromCharCode(27);
    const payload = legacyPushPayload({
      ...BASE_INPUT,
      unsupported: [["db", `evil${esc}[31mred\nline`]],
    });
    expect(payload["unsupported"]).toEqual([["db", `evil${esc}[31mred\nline`]]);
  });
});
