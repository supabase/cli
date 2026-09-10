import { describe, expect, test } from "vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { validateCliConfig } from "./validate.ts";

const incompleteTwilio = {
  enabled: true,
  account_sid: "",
  message_service_sid: "",
};

describe("validateCliConfig", () => {
  test("accepts a valid effective config", async () => {
    const config = await Effect.runPromise(
      validateCliConfig({
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
      }),
    );

    expect(config.auth.sms.twilio.enabled).toBe(true);
    expect(config.auth.sms.twilio.account_sid).toBe("AC123");
  });

  test("rejects an incomplete enabled provider in the effective config", async () => {
    const loaded = await Effect.runPromise(
      validateCliConfig({
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
      }),
    );
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
    const exit = await Effect.runPromiseExit(validateCliConfig(overridden));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(Schema.isSchemaError(error.value)).toBe(true);
      }
    }
  });

  test("accepts incomplete unselected remotes but rejects structurally invalid remotes", async () => {
    const config = await Effect.runPromise(
      validateCliConfig({
        remotes: {
          staging: { auth: { sms: { twilio: incompleteTwilio } } },
        },
      }),
    );
    expect(config.remotes.staging).toBeDefined();
    if (config.remotes.staging !== undefined) {
      expect(config.remotes.staging.auth.sms.twilio.enabled).toBe(true);
    }

    const exit = await Effect.runPromiseExit(
      validateCliConfig({ remotes: { staging: { project_id: 123 } } }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
