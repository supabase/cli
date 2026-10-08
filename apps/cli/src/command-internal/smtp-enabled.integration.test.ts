import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { withConfigEnv } from "../../tests/helpers/command-mocks.ts";
import { definedEnv } from "../../tests/helpers/config-env-pins.ts";
import { configValuesLayer } from "../../tests/helpers/config-snapshot-layer.ts";
import { createStackConfigProject } from "../../tests/helpers/stack-config.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import { resolveSmtpEnabled } from "./smtp-enabled.ts";

const smtpEnabled = (config: string, shell: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const root = yield* createStackConfigProject(config, { prefix: "supabase-smtp-enabled-" });
    const snapshot = yield* CliConfigValues.use((values) =>
      values.load({ workdir: root, projectRef: Option.none() }),
    ).pipe(Effect.provide(configValuesLayer()));
    return resolveSmtpEnabled(snapshot);
  }).pipe(
    Effect.provide(BunServices.layer),
    (effect) => withConfigEnv(definedEnv(shell), effect),
    Effect.scoped,
  );

describe("resolveSmtpEnabled", () => {
  it.live("is off when [auth.email.smtp] is absent", () =>
    Effect.gen(function* () {
      expect(yield* smtpEnabled('project_id = "p"\n')).toBe(false);
    }),
  );

  it.live("is on when the table is present and leaves enabled out", () =>
    Effect.gen(function* () {
      expect(yield* smtpEnabled('[auth.email.smtp]\nhost = "smtp.test"\n')).toBe(true);
    }),
  );

  it.live("follows an explicit enabled = false", () =>
    Effect.gen(function* () {
      expect(yield* smtpEnabled("[auth.email.smtp]\nenabled = false\n")).toBe(false);
    }),
  );

  it.live("follows an env override of enabled over a present table", () =>
    Effect.gen(function* () {
      const config = "[auth.email.smtp]\nenabled = true\n";
      expect(yield* smtpEnabled(config, { SUPABASE_AUTH_EMAIL_SMTP_ENABLED: "false" })).toBe(false);
    }),
  );
});
