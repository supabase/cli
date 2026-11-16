import type { ConfigChange } from "@supabase/config";
import { describe, expect, test } from "vitest";

import { configProviderDisableWarnings } from "./config.format.ts";

const EMAIL_WARNING =
  "Warning: auth.email.enabled = false turns off the email provider, so existing users can no longer sign in with email (password, magic link or OTP). To block new signups only, set auth.enable_signup = false and keep auth.email.enabled = true.";

const SMS_WARNING =
  "Warning: auth.sms.enabled = false turns off the phone provider, so existing users can no longer sign in with a phone number (password or SMS OTP). To block new signups only, set auth.enable_signup = false and keep auth.sms.enabled = true.";

function change(
  path: ReadonlyArray<string>,
  local: unknown,
  remote: unknown,
  overrides: Partial<ConfigChange> = {},
): ConfigChange {
  return { path, class: "update", declared: true, local, remote, ...overrides };
}

const EMAIL = ["auth", "email", "enable_signup"];
const SMS = ["auth", "sms", "enable_signup"];

describe("configProviderDisableWarnings", () => {
  test.each([
    { provider: "email", path: EMAIL, warning: EMAIL_WARNING },
    { provider: "sms", path: SMS, warning: SMS_WARNING },
  ])("warns when a declared $provider provider goes from on to off", ({ path, warning }) => {
    expect(configProviderDisableWarnings([change(path, false, true)])).toEqual([warning]);
  });

  test.each([
    { order: "email then sms", changes: [EMAIL, SMS], expected: [EMAIL_WARNING, SMS_WARNING] },
    { order: "sms then email", changes: [SMS, EMAIL], expected: [SMS_WARNING, EMAIL_WARNING] },
  ])("follows the change order when both providers go off ($order)", ({ changes, expected }) => {
    expect(configProviderDisableWarnings(changes.map((path) => change(path, false, true)))).toEqual(
      expected,
    );
  });

  test("ignores unrelated changes sitting between warned ones", () => {
    expect(
      configProviderDisableWarnings([
        change(EMAIL, false, true),
        change(["api", "max_rows"], 500, 1000),
        change(SMS, false, true),
      ]),
    ).toEqual([EMAIL_WARNING, SMS_WARNING]);
  });

  test.each([
    { name: "a provider turned on", changes: [change(EMAIL, true, false)] },
    {
      name: "an undeclared schema-default local value",
      changes: [change(EMAIL, false, true, { class: "remote_only", declared: false })],
    },
    { name: "a remote value that is already off", changes: [change(EMAIL, false, false)] },
    {
      name: "a remote value the API did not report",
      changes: [change(SMS, false, undefined, { class: "local_only" })],
    },
    {
      name: "the project-wide signup switch",
      changes: [change(["auth", "enable_signup"], false, true)],
    },
    {
      name: "the same key under another block",
      changes: [change(["storage", "email", "enable_signup"], false, true)],
    },
    {
      name: "a single segment that joins to the same dotted path",
      changes: [change(["auth", "email.enable_signup"], false, true)],
    },
  ])("stays silent for $name", ({ changes }) => {
    expect(configProviderDisableWarnings(changes)).toEqual([]);
  });
});
