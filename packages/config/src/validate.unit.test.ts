import { describe, expect, test } from "vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { validateCliConfig } from "./validate.ts";

const incompleteTwilio = {
  enabled: true,
  account_sid: "",
  message_service_sid: "",
};

describe("validateCliConfig", () => {
  test("accepts a valid effective config", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* validateCliConfig({
          auth: {
            sms: {
              twilio: {
                enabled: true,
                account_sid: "AC123",
                message_service_sid: "MG123",
                auth_token: "token",
              },
            },
          },
        });

        expect(config.auth.sms.twilio.enabled).toBe(true);
        expect(config.auth.sms.twilio.account_sid).toBe("AC123");
      }),
    ));

  test("rejects an incomplete enabled provider in the effective config", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const loaded = yield* validateCliConfig({
          auth: {
            sms: {
              twilio: {
                enabled: true,
                account_sid: "AC123",
                message_service_sid: "MG123",
                auth_token: "token",
              },
            },
          },
        });
        const overridden = {
          ...loaded,
          auth: {
            ...loaded.auth,
            sms: {
              ...loaded.auth.sms,
              twilio: { ...loaded.auth.sms.twilio, ...incompleteTwilio },
            },
          },
        };
        const exit = yield* Effect.exit(validateCliConfig(overridden));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(Schema.isSchemaError(error.value)).toBe(true);
          }
        }
      }),
    ));

  test("accepts incomplete unselected remotes but rejects structurally invalid remotes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* validateCliConfig({
          remotes: {
            staging: { auth: { sms: { twilio: incompleteTwilio } } },
          },
        });
        expect(config.remotes.staging).toBeDefined();
        if (config.remotes.staging !== undefined) {
          expect(config.remotes.staging.auth.sms.twilio.enabled).toBe(true);
        }

        const exit = yield* Effect.exit(
          validateCliConfig({ remotes: { staging: { project_id: 123 } } }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ));
});

describe("validateCliConfig provider switch alias", () => {
  test.each([
    { name: "email enabled = false", section: "email", keys: { enabled: false }, expected: false },
    { name: "sms enabled = false", section: "sms", keys: { enabled: false }, expected: false },
    {
      name: "email enabled = false against enable_signup = true",
      section: "email",
      keys: { enabled: false, enable_signup: true },
      expected: false,
    },
    {
      name: "sms enabled = true against enable_signup = false",
      section: "sms",
      keys: { enabled: true, enable_signup: false },
      expected: true,
    },
  ] as const)("folds $name into enable_signup and drops enabled", ({ section, keys, expected }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* validateCliConfig({ auth: { [section]: keys } });

        expect(config.auth[section].enable_signup).toBe(expected);
        expect(config.auth[section]).not.toHaveProperty("enabled");
      }),
    ),
  );

  test("folds a remote's enabled into that remote's enable_signup and leaves the base alone", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* validateCliConfig({
          remotes: {
            staging: { auth: { email: { enabled: false, enable_signup: true } } },
          },
        });

        expect(config.remotes.staging?.auth.email.enable_signup).toBe(false);
        expect(config.remotes.staging?.auth.email).not.toHaveProperty("enabled");
        expect(config.auth.email.enable_signup).toBe(true);
      }),
    ));
});
