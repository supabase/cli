import type { ConfigChange } from "@supabase/config/internal";
import { describe, expect, test } from "vitest";

import type { LegacyPushResource } from "./push.plan.ts";
import type { LegacyPushSecretReport } from "./push.secrets.ts";
import {
  legacyPushNotes,
  legacyPushNotPushableLine,
  legacyPushPayload,
  legacyPushSummaryMessage,
  legacyPushUpdatingLine,
  legacyPushUpToDateLine,
  type LegacyPushPayloadInput,
} from "./push.format.ts";

const API_MAX_ROWS_CHANGE: ConfigChange = {
  path: ["api", "max_rows"],
  class: "update",
  declared: true,
  local: 2000,
  remote: 1000,
};

const SENT_SECRET: LegacyPushSecretReport = {
  path: ["auth", "captcha", "secret"],
  apiKey: "security_captcha_secret",
  status: "send",
  remoteState: "present",
};

const SENT_SECRET_ABSENT_REMOTE: LegacyPushSecretReport = {
  path: ["auth", "captcha", "secret"],
  apiKey: "security_captcha_secret",
  status: "send",
  remoteState: "absent",
};

const UNCHANGED_SECRET: LegacyPushSecretReport = {
  path: ["auth", "hook", "mfa_verification_attempt", "secrets"],
  apiKey: "hook_mfa_verification_attempt_secrets",
  status: "unchanged",
  remoteState: "present",
};

const NOT_SET_SECRET: LegacyPushSecretReport = {
  path: ["auth", "sms", "twilio", "auth_token"],
  apiKey: "sms_twilio_auth_token",
  status: "not_set",
  remoteState: "absent",
};

const GATED_SECRET: LegacyPushSecretReport = {
  path: ["auth", "hook", "send_sms", "secrets"],
  apiKey: "hook_send_sms_secrets",
  status: "gated",
  remoteState: "absent",
};

const NO_EXTRAS_OR_FORCED = { extras: [], forced: [] };

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
    expect(
      legacyPushUpdatingLine({
        resource,
        changes: [API_MAX_ROWS_CHANGE],
        secrets: [],
        ...NO_EXTRAS_OR_FORCED,
      }),
    ).toBe(`${prefix}\napi.max_rows [update]\n  local:  2000\n  remote: 1000\n\n`);
  });

  test("appends a [secret] block for a status: send secret, directly after the change lines", () => {
    expect(
      legacyPushUpdatingLine({
        resource: "auth",
        changes: [API_MAX_ROWS_CHANGE],
        secrets: [SENT_SECRET],
        ...NO_EXTRAS_OR_FORCED,
      }),
    ).toBe(
      "Updating Auth service with config:\n" +
        "api.max_rows [update]\n" +
        "  local:  2000\n" +
        "  remote: 1000\n" +
        "\n" +
        "auth.captcha.secret [secret]\n" +
        "  local:  (set)\n" +
        "  remote: (set — differs)\n" +
        "\n",
    );
  });

  test("a sent secret's remote digest absent renders 'remote: (not set)'", () => {
    expect(
      legacyPushUpdatingLine({
        resource: "auth",
        changes: [],
        secrets: [SENT_SECRET_ABSENT_REMOTE],
        ...NO_EXTRAS_OR_FORCED,
      }),
    ).toBe(
      "Updating Auth service with config:\n" +
        "auth.captcha.secret [secret]\n" +
        "  local:  (set)\n" +
        "  remote: (not set)\n" +
        "\n",
    );
  });

  test("discloses a not_set secret BEFORE the prompt, inside the same block", () => {
    expect(
      legacyPushUpdatingLine({
        resource: "auth",
        changes: [],
        secrets: [NOT_SET_SECRET],
        ...NO_EXTRAS_OR_FORCED,
      }),
    ).toBe(
      "Updating Auth service with config:\n" +
        "auth.sms.twilio.auth_token [secret]\n" +
        "  local:  (not set — unresolved env reference; will not be pushed)\n" +
        "  remote: (not set)\n" +
        "\n",
    );
  });

  test("never renders the secret plaintext or the digest itself", () => {
    const rendered = legacyPushUpdatingLine({
      resource: "auth",
      changes: [],
      secrets: [SENT_SECRET],
      ...NO_EXTRAS_OR_FORCED,
    });
    expect(rendered).not.toContain("(digest)");
  });

  test("omits unchanged and gated secrets from the block", () => {
    expect(
      legacyPushUpdatingLine({
        resource: "auth",
        changes: [],
        secrets: [UNCHANGED_SECRET, GATED_SECRET],
        ...NO_EXTRAS_OR_FORCED,
      }),
    ).toBe("Updating Auth service with config:\n");
  });

  test("renders a [content] block for a template/notification body with no registry row", () => {
    expect(
      legacyPushUpdatingLine({
        resource: "auth",
        changes: [],
        secrets: [],
        extras: [{ path: ["auth", "email", "template", "invite", "content"], label: "content" }],
        forced: [],
      }),
    ).toBe(
      "Updating Auth service with config:\n" +
        "auth.email.template.invite.content [content]\n" +
        "  local:  (file content from content_path)\n" +
        "  remote: (differs)\n" +
        "\n",
    );
  });

  test("renders a [group-write] block for an undeclared companion sent at its schema default", () => {
    expect(
      legacyPushUpdatingLine({
        resource: "db.network_restrictions",
        changes: [],
        secrets: [],
        extras: [],
        forced: [{ path: ["db", "network_restrictions", "allowed_cidrs_v6"], value: [] }],
      }),
    ).toBe(
      "Updating network restrictions with config:\n" +
        "db.network_restrictions.allowed_cidrs_v6 [group-write]\n" +
        "  local:  [] (schema default — not declared in config.toml)\n" +
        "  remote: (not returned)\n" +
        "\n",
    );
  });

  test("ends on a blank line and separates change lines from the first special block", () => {
    const rendered = legacyPushUpdatingLine({
      resource: "auth",
      changes: [API_MAX_ROWS_CHANGE],
      secrets: [SENT_SECRET],
      extras: [{ path: ["auth", "email", "template", "invite", "content"], label: "content" }],
      forced: [],
    });
    expect(rendered.endsWith("\n\n")).toBe(true);
    expect(rendered).toBe(
      "Updating Auth service with config:\n" +
        "api.max_rows [update]\n" +
        "  local:  2000\n" +
        "  remote: 1000\n" +
        "\n" +
        "auth.captcha.secret [secret]\n" +
        "  local:  (set)\n" +
        "  remote: (set — differs)\n" +
        "\n" +
        "auth.email.template.invite.content [content]\n" +
        "  local:  (file content from content_path)\n" +
        "  remote: (differs)\n" +
        "\n",
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
    const rendered = legacyPushUpdatingLine({
      resource: "auth",
      changes: [hostile],
      secrets: [],
      ...NO_EXTRAS_OR_FORCED,
    });
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

describe("legacyPushNotPushableLine", () => {
  test("singular and plural difference count", () => {
    expect(legacyPushNotPushableLine("api", 1)).toBe(
      "Remote API config has 1 difference config push cannot write (see notes below).\n",
    );
    expect(legacyPushNotPushableLine("storage", 3)).toBe(
      "Remote Storage config has 3 differences config push cannot write (see notes below).\n",
    );
  });
});

const EMPTY_NOTES = {
  unsupported: [],
  unencodable: [],
  unmanagedCount: 0,
  forced: [],
  secretsNotSet: [],
  remoteOnly: 0,
};

describe("legacyPushNotes", () => {
  test('returns "" when there is nothing to note', () => {
    expect(legacyPushNotes(EMPTY_NOTES)).toBe("");
  });

  test("unsupported: singular and plural", () => {
    expect(legacyPushNotes({ ...EMPTY_NOTES, unsupported: [["db", "major_version"]] })).toBe(
      "Note: 1 declared property has no Management API field and was not pushed: db.major_version (change them from the dashboard).\n",
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
      "Note: 2 declared properties have no Management API field and were not pushed: db.pooler.pool_mode, db.major_version (change them from the dashboard).\n",
    );
  });

  test("unencodable: singular and plural, one reason per path", () => {
    expect(
      legacyPushNotes({
        ...EMPTY_NOTES,
        unencodable: [{ path: ["api", "enabled"], reason: "enabling the Data API needs at least one schema in api.schemas" }],
      }),
    ).toBe(
      "Note: 1 declared property could not be encoded and was not pushed: api.enabled (enabling the Data API needs at least one schema in api.schemas)\n",
    );
    expect(
      legacyPushNotes({
        ...EMPTY_NOTES,
        unencodable: [
          { path: ["api", "enabled"], reason: "enabling the Data API needs at least one schema in api.schemas" },
          { path: ["auth", "sms", "twilio", "enabled"], reason: "config push can switch between SMS providers but cannot turn the active provider off; disable phone sign-in or use the dashboard" },
        ],
      }),
    ).toBe(
      "Note: 2 declared properties could not be encoded and were not pushed: " +
        "api.enabled (enabling the Data API needs at least one schema in api.schemas), " +
        "auth.sms.twilio.enabled (config push can switch between SMS providers but cannot turn the active provider off; disable phone sign-in or use the dashboard)\n",
    );
  });

  test("unmanagedCount: singular and plural, count only (no path list)", () => {
    expect(legacyPushNotes({ ...EMPTY_NOTES, unmanagedCount: 1 })).toBe(
      "Note: 1 declared property is not managed by config push and was not compared; run `supabase config diff` to list them.\n",
    );
    expect(legacyPushNotes({ ...EMPTY_NOTES, unmanagedCount: 3 })).toBe(
      "Note: 3 declared properties are not managed by config push and were not compared; run `supabase config diff` to list them.\n",
    );
  });

  test("forced: singular and plural", () => {
    expect(
      legacyPushNotes({
        ...EMPTY_NOTES,
        forced: [{ path: ["db", "network_restrictions", "allowed_cidrs_v6"], value: [] }],
      }),
    ).toBe(
      "Note: 1 undeclared property had to be sent alongside a declared change and was written at its config default: db.network_restrictions.allowed_cidrs_v6\n",
    );
    expect(
      legacyPushNotes({
        ...EMPTY_NOTES,
        forced: [
          { path: ["db", "network_restrictions", "allowed_cidrs_v6"], value: [] },
          { path: ["storage", "vector", "max_indexes"], value: 100 },
        ],
      }),
    ).toBe(
      "Note: 2 undeclared properties had to be sent alongside a declared change and were written at their config default: " +
        "db.network_restrictions.allowed_cidrs_v6, storage.vector.max_indexes\n",
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

  test("remoteOnly: singular and plural, config-push-specific wording", () => {
    expect(legacyPushNotes({ ...EMPTY_NOTES, remoteOnly: 1 })).toBe(
      "Note: 1 remote property is not declared in supabase/config.toml and was left unchanged (config push no longer resets undeclared properties to their defaults; run `supabase config diff` to inspect).\n",
    );
    expect(legacyPushNotes({ ...EMPTY_NOTES, remoteOnly: 12 })).toBe(
      "Note: 12 remote properties are not declared in supabase/config.toml and were left unchanged (config push no longer resets undeclared properties to their defaults; run `supabase config diff` to inspect).\n",
    );
  });

  test("combines every present category in the established order", () => {
    expect(
      legacyPushNotes({
        unsupported: [["db", "major_version"]],
        unencodable: [{ path: ["api", "enabled"], reason: "enabling the Data API needs at least one schema in api.schemas" }],
        unmanagedCount: 1,
        forced: [{ path: ["db", "network_restrictions", "allowed_cidrs_v6"], value: [] }],
        secretsNotSet: [["auth", "captcha", "secret"]],
        remoteOnly: 12,
      }),
    ).toBe(
      "Note: 1 declared property has no Management API field and was not pushed: db.major_version (change them from the dashboard).\n" +
        "Note: 1 declared property could not be encoded and was not pushed: api.enabled (enabling the Data API needs at least one schema in api.schemas)\n" +
        "Note: 1 declared property is not managed by config push and was not compared; run `supabase config diff` to list them.\n" +
        "Note: 1 undeclared property had to be sent alongside a declared change and was written at its config default: db.network_restrictions.allowed_cidrs_v6\n" +
        "Note: 1 credential value was not pushed (empty or unresolved env reference): auth.captcha.secret\n" +
        "Note: 12 remote properties are not declared in supabase/config.toml and were left unchanged (config push no longer resets undeclared properties to their defaults; run `supabase config diff` to inspect).\n",
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
      "Note: 1 declared property has no Management API field and was not pushed: db.evil[31mred No config differences found. (change them from the dashboard).\n",
    );
  });
});

describe("legacyPushSummaryMessage", () => {
  const EMPTY_SUMMARY_INPUT: LegacyPushPayloadInput = {
    projectRef: "abcdefghijklmnopqrst",
    services: [],
    unsupported: [],
    unencodable: [],
    forced: [],
    unmanaged: [],
    secrets: [],
    authWriteRan: false,
    declinedAddons: [],
    remoteOnly: 0,
    scope: { present: [], missing: [] },
  };

  test("base: singular property count when one service updated", () => {
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        services: [{ service: "api", status: "updated", changes: [["api", "max_rows"]] }],
      }),
    ).toBe("1 property pushed to abcdefghijklmnopqrst.");
  });

  test("base: plural property count, summed across every updated service's changes", () => {
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        services: [
          {
            service: "api",
            status: "updated",
            changes: [
              ["api", "max_rows"],
              ["api", "extra_search_path"],
            ],
          },
          { service: "storage", status: "updated", changes: [["storage", "file_size_limit"]] },
          { service: "db.settings", status: "up_to_date", changes: [] },
        ],
      }),
    ).toBe("3 properties pushed to abcdefghijklmnopqrst.");
  });

  test('base: "Nothing to push" when every service is up_to_date/disabled', () => {
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        services: [
          { service: "api", status: "up_to_date", changes: [] },
          { service: "db.network_restrictions", status: "disabled", changes: [] },
        ],
      }),
    ).toBe("Nothing to push: the project already matches the declared properties.");
  });

  test('base: "Nothing was pushed" when nothing updated but something was withheld', () => {
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        services: [
          { service: "auth", status: "not_pushable", changes: [] },
          { service: "storage", status: "unavailable", changes: [] },
        ],
      }),
    ).toBe("Nothing was pushed.");
  });

  test("caveat: unsupported + unencodable, singular and plural", () => {
    expect(
      legacyPushSummaryMessage({ ...EMPTY_SUMMARY_INPUT, unsupported: [["db", "major_version"]] }),
    ).toBe("Nothing to push: the project already matches the declared properties. 1 declared property could not be pushed.");
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        unsupported: [["db", "major_version"]],
        unencodable: [
          { path: ["api", "enabled"], reason: "enabling the Data API needs at least one schema in api.schemas" },
        ],
      }),
    ).toBe(
      "Nothing to push: the project already matches the declared properties. 2 declared properties could not be pushed.",
    );
  });

  test("caveat: unmanaged, singular and plural", () => {
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        unmanaged: [["auth", "oauth_server", "enabled"]],
      }),
    ).toBe(
      "Nothing to push: the project already matches the declared properties. 1 declared property is not managed by config push.",
    );
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        unmanaged: [
          ["auth", "oauth_server", "enabled"],
          ["auth", "oauth_server", "allow_dynamic_registration"],
        ],
      }),
    ).toBe(
      "Nothing to push: the project already matches the declared properties. 2 declared properties are not managed by config push.",
    );
  });

  test("caveat: scope.missing, singular and plural", () => {
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        scope: { present: [], missing: ["auth"] },
      }),
    ).toBe(
      "Nothing to push: the project already matches the declared properties. 1 block was not returned by the API.",
    );
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        scope: { present: [], missing: ["auth", "storage"] },
      }),
    ).toBe(
      "Nothing to push: the project already matches the declared properties. 2 blocks were not returned by the API.",
    );
  });

  test("caveat: skipped services, singular and plural", () => {
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        services: [{ service: "auth", status: "skipped", changes: [["auth", "site_url"]] }],
      }),
    ).toBe("Nothing was pushed. 1 service was skipped at the prompt.");
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        services: [
          { service: "auth", status: "skipped", changes: [["auth", "site_url"]] },
          { service: "storage", status: "skipped", changes: [["storage", "file_size_limit"]] },
        ],
      }),
    ).toBe("Nothing was pushed. 2 services were skipped at the prompt.");
  });

  test("caveat: not-set credentials, singular and plural", () => {
    expect(
      legacyPushSummaryMessage({ ...EMPTY_SUMMARY_INPUT, secrets: [NOT_SET_SECRET] }),
    ).toBe(
      "Nothing to push: the project already matches the declared properties. 1 credential value was not pushed.",
    );
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        secrets: [NOT_SET_SECRET, { ...NOT_SET_SECRET, path: ["auth", "captcha", "secret"] }],
      }),
    ).toBe(
      "Nothing to push: the project already matches the declared properties. 2 credential values were not pushed.",
    );
  });

  test("caveat: declined add-on prompts, singular and plural", () => {
    expect(
      legacyPushSummaryMessage({ ...EMPTY_SUMMARY_INPUT, declinedAddons: ["auth_mfa_phone"] }),
    ).toBe("Nothing to push: the project already matches the declared properties. 1 add-on prompt declined.");
    expect(
      legacyPushSummaryMessage({
        ...EMPTY_SUMMARY_INPUT,
        declinedAddons: ["auth_mfa_phone", "auth_mfa_web_authn"],
      }),
    ).toBe("Nothing to push: the project already matches the declared properties. 2 add-on prompts declined.");
  });

  test("combines every present caveat in the established order", () => {
    expect(
      legacyPushSummaryMessage({
        projectRef: "abcdefghijklmnopqrst",
        services: [
          { service: "api", status: "updated", changes: [["api", "max_rows"]] },
          { service: "auth", status: "skipped", changes: [["auth", "site_url"]] },
        ],
        unsupported: [["db", "major_version"]],
        unencodable: [],
        forced: [],
        unmanaged: [["auth", "oauth_server", "enabled"]],
        secrets: [NOT_SET_SECRET],
        authWriteRan: false,
        declinedAddons: ["auth_mfa_phone"],
        remoteOnly: 12,
        scope: { present: [], missing: ["auth"] },
      }),
    ).toBe(
      "1 property pushed to abcdefghijklmnopqrst. " +
        "1 declared property could not be pushed. " +
        "1 declared property is not managed by config push. " +
        "1 block was not returned by the API. " +
        "1 service was skipped at the prompt. " +
        "1 credential value was not pushed. " +
        "1 add-on prompt declined.",
    );
  });

  test("sanitizes a hostile project ref so it cannot inject ANSI or forge output lines", () => {
    const esc = String.fromCharCode(27);
    const rendered = legacyPushSummaryMessage({
      ...EMPTY_SUMMARY_INPUT,
      projectRef: `evil${esc}[31mred\nNothing to push.`,
      services: [{ service: "api", status: "updated", changes: [["api", "max_rows"]] }],
    });
    expect(rendered).not.toContain(esc);
    expect(rendered).toBe("1 property pushed to evil[31mred Nothing to push..");
  });
});

describe("legacyPushPayload", () => {
  const BASE_INPUT = {
    projectRef: "abcdefghijklmnopqrst",
    services: [{ service: "api", status: "updated", changes: [["api", "max_rows"]] }],
    unsupported: [["db", "pooler", "pool_mode"]],
    unencodable: [{ path: ["api", "enabled"], reason: "enabling the Data API needs at least one schema in api.schemas" }],
    forced: [{ path: ["db", "network_restrictions", "allowed_cidrs_v6"], value: [] }],
    unmanaged: [["auth", "oauth_server", "enabled"]],
    secrets: [SENT_SECRET, UNCHANGED_SECRET, NOT_SET_SECRET, GATED_SECRET],
    authWriteRan: true,
    declinedAddons: ["auth_mfa_phone"],
    remoteOnly: 12,
    scope: { present: ["api", "auth", "database", "pooler", "realtime", "storage"], missing: [] },
  };

  test("shapes the full payload, bucketing secrets across all five statuses", () => {
    expect(legacyPushPayload(BASE_INPUT)).toEqual({
      schema_version: 1,
      project_ref: "abcdefghijklmnopqrst",
      services: [{ service: "api", status: "updated", changes: [["api", "max_rows"]] }],
      unsupported: [["db", "pooler", "pool_mode"]],
      unencodable: [{ path: ["api", "enabled"], reason: "enabling the Data API needs at least one schema in api.schemas" }],
      forced: [{ path: ["db", "network_restrictions", "allowed_cidrs_v6"], value: [] }],
      unmanaged: [["auth", "oauth_server", "enabled"]],
      secrets: {
        sent: [["auth", "captcha", "secret"]],
        unchanged: [["auth", "hook", "mfa_verification_attempt", "secrets"]],
        not_set: [["auth", "sms", "twilio", "auth_token"]],
        gated: [["auth", "hook", "send_sms", "secrets"]],
        skipped: [],
      },
      declined_addons: ["auth_mfa_phone"],
      remote_only: 12,
      scope: { present: ["api", "auth", "database", "pooler", "realtime", "storage"], missing: [] },
    });
  });

  test("a status: send secret lands in 'skipped', not 'sent', when the auth write did not run", () => {
    const payload = legacyPushPayload({ ...BASE_INPUT, authWriteRan: false });
    expect(payload["secrets"]).toEqual({
      sent: [],
      unchanged: [["auth", "hook", "mfa_verification_attempt", "secrets"]],
      not_set: [["auth", "sms", "twilio", "auth_token"]],
      gated: [["auth", "hook", "send_sms", "secrets"]],
      skipped: [["auth", "captcha", "secret"]],
    });
  });

  test("empty arrays round-trip as empty arrays, not omitted keys", () => {
    expect(
      legacyPushPayload({
        projectRef: "abcdefghijklmnopqrst",
        services: [],
        unsupported: [],
        unencodable: [],
        forced: [],
        unmanaged: [],
        secrets: [],
        authWriteRan: false,
        declinedAddons: [],
        remoteOnly: 0,
        scope: { present: [], missing: [] },
      }),
    ).toEqual({
      schema_version: 1,
      project_ref: "abcdefghijklmnopqrst",
      services: [],
      unsupported: [],
      unencodable: [],
      forced: [],
      unmanaged: [],
      secrets: { sent: [], unchanged: [], not_set: [], gated: [], skipped: [] },
      declined_addons: [],
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
