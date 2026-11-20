import { Config, Data, Effect, Result } from "effect";
import { Command } from "effect/cli";
import { ROOT_GLOBAL_FLAGS } from "../../src/command-internal/global-flags.ts";
import { withStandardErrors } from "../../src/command-internal/command-errors/command-errors.annotation.ts";
import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "../../src/command-internal/hosted-consent/hosted-consent.errors.ts";
import { parseTargetSelector } from "../../src/command-internal/target/target-selector.ts";
import { projectTargetFlags } from "../../src/command-internal/target/target-flags.ts";
import { ApiCommandStatusError } from "../../src/command-internal/command-errors/api-command.errors.ts";
import { runCli } from "../../src/shared/cli/run.ts";
import { mockAnalytics } from "../helpers/mocks.ts";

class LegacyBoomError extends Data.TaggedError("LegacyBoomError")<{ readonly message: string }> {}

const standard = <E>(name: string, handler: Effect.Effect<never, E>) =>
  Command.make(name, {}, () => handler).pipe(withStandardErrors);

const root = Command.make("supabase").pipe(
  Command.withSubcommands([
    standard(
      "conflict",
      Effect.fail(
        new ApiCommandStatusError({
          status: 409,
          message: "Resource already exists",
          apiCode: "already_exists",
          hint: "Pick another name",
        }),
      ),
    ),
    standard(
      "plan-gated",
      Effect.fail(
        new ApiCommandStatusError({
          status: 403,
          message: "Upgrade required",
          entitlement: {
            feature: "warehouse",
            upgrade_url: "https://supabase.com/dashboard/org/acme/billing",
          },
        }),
      ),
    ),
    standard(
      "needs-consent",
      Effect.fail(
        new HostedMutationConsentRequiredError({
          message: "Confirmation required: delete things",
          suggestion: "Re-run with --yes to confirm.",
        }),
      ),
    ),
    Command.make("select", projectTargetFlags(), (flags) =>
      Result.match(
        parseTargetSelector({
          remote: flags.remote,
          projectRef: flags.projectRef,
          local: false,
          linked: false,
        }),
        { onFailure: Effect.fail, onSuccess: Effect.succeed },
      ),
    ).pipe(withStandardErrors),
    standard("declined", Effect.fail(new HostedMutationDeclinedError({ message: "Declined" }))),
    standard("crash", Effect.die(new Error("boom"))),
    Command.make("legacy", {}, () => Effect.fail(new LegacyBoomError({ message: "legacy boom" }))),
  ]),
  Command.withGlobalFlags(ROOT_GLOBAL_FLAGS),
);

const simulateTty = await Effect.runPromise(
  Config.Boolean("STANDARD_ERRORS_FIXTURE_TTY").pipe(Config.withDefault(false)),
);
if (simulateTty) {
  Object.defineProperty(process.stdout, "isTTY", { value: true });
}

await Effect.runPromise(
  runCli(root, { agentDefaultOutputFormat: "json", analyticsLayer: mockAnalytics().layer }),
);
