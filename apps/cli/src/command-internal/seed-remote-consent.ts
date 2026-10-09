import { Effect, Option, Path, Predicate } from "effect";

import { CliConfigKeys } from "../config/cli-config-keys.ts";
import { describeCliConfigOrigin } from "../config/cli-config-key.ts";
import type { ResolvedCliConfig } from "../config/cli-config-values.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { Tty } from "../shared/runtime/tty.service.ts";
import { promptYesNoOutcome } from "./prompt-yes-no.ts";
import { SeedConsentRequiredError } from "./seed-remote-consent.errors.ts";

/** A seed run that needs consent because its target matched a `[remotes.*]` block. */
export interface SeedConsentTarget {
  readonly ref: string;
  readonly remote: string;
  /** What turned seeding on, as `describeCliConfigOrigin` words it. */
  readonly enabledBy: string;
}

/** The effective `[db.seed]` values a command acts on, plus the consent its target needs. */
export interface DbSeedInput {
  readonly enabled: boolean;
  readonly sqlPaths: ReadonlyArray<string>;
  readonly consent: SeedConsentTarget | undefined;
}

type SeedConsentCommand = "push" | "reset";

const SEED_CONSENT_SUGGESTIONS: Record<SeedConsentCommand, string> = {
  push: "Pass --yes to seed, or drop --include-seed to push migrations only.",
  reset: "Pass --yes to seed, or --no-seed to reset without seeding.",
};

const remoteDeclaresSeedEnabled = (resolvedConfig: ResolvedCliConfig, remote: string): boolean => {
  const block = resolvedConfig.loaded.interpolatedRemotes?.[remote];
  const declared =
    Predicate.hasProperty(block, "db") &&
    Predicate.hasProperty(block.db, "seed") &&
    Predicate.hasProperty(block.db.seed, "enabled")
      ? block.db.seed.enabled
      : undefined;
  return CliConfigKeys.db.seed.enabled.codec.fromConfig(declared) === true;
};

/**
 * Reads `[db.seed]` through the resolved config. Seeding needs consent only when the target matched a
 * `[remotes.*]` block that does not itself turn seeding on.
 */
export const resolveDbSeedInput = Effect.fn("DbSeedInput.resolve")(function* (
  resolvedConfig: ResolvedCliConfig,
  target: { readonly workdir: string; readonly ref: string },
) {
  const path = yield* Path.Path;
  const enabled = yield* resolvedConfig.get(CliConfigKeys.db.seed.enabled);
  const sqlPaths = yield* resolvedConfig.get(CliConfigKeys.db.seed.sqlPaths);
  const remote = Option.getOrUndefined(resolvedConfig.appliedRemote);
  const consent: SeedConsentTarget | undefined =
    remote === undefined || remoteDeclaresSeedEnabled(resolvedConfig, remote)
      ? undefined
      : {
          ref: target.ref,
          remote,
          enabledBy: describeCliConfigOrigin(enabled.origin, { workdir: target.workdir, path }),
        };
  return { enabled: enabled.value, sqlPaths: sqlPaths.value, consent } satisfies DbSeedInput;
});

/** Whether a prompt can reach someone: a real terminal, or a piped line standing in for one. */
const canPromptForSeed = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const tty = yield* Tty;
  return tty.stdinIsTty ? output.interactive && output.format === "text" : true;
});

const requiredError = (target: SeedConsentTarget, command: SeedConsentCommand) =>
  new SeedConsentRequiredError({
    message: `Seeding ${target.ref} ([remotes.${target.remote}]) needs confirmation and this run can't prompt. Nothing was changed.`,
    suggestion: SEED_CONSENT_SUGGESTIONS[command],
  });

/** The note `--dry-run` prints so a real run's consent step isn't a surprise. */
export const seedConsentDryRunNote = Effect.fnUntraced(function* (
  target: SeedConsentTarget,
  yes: boolean,
) {
  if (yes) return;
  const output = yield* Output;
  const action = (yield* canPromptForSeed())
    ? "will ask before seeding"
    : "will need --yes to seed";
  yield* output.raw(`A real run ${action} ${target.ref} ([remotes.${target.remote}]).\n`, "stderr");
});

/**
 * Asks before seeding a project whose target matched a `[remotes.*]` block, defaulting to no.
 * Returns `false` when the answer is no; fails with `SeedConsentRequiredError` when nothing can ask
 * or piped stdin ends without an answer line.
 */
export const confirmSeedIntoMatchedRemote = Effect.fnUntraced(function* (input: {
  readonly command: SeedConsentCommand;
  readonly target: SeedConsentTarget;
  readonly files: ReadonlyArray<string>;
  readonly yes: boolean;
}) {
  const { command, target, files, yes } = input;
  const output = yield* Output;
  if (!yes && !(yield* canPromptForSeed())) return yield* requiredError(target, command);
  const noun = files.length === 1 ? "seed file" : "seed files";
  const outcome = yield* promptYesNoOutcome(
    output,
    yes,
    `Project ${target.ref} matches [remotes.${target.remote}]. Run ${files.length} ${noun} (${files.join(", ")}) against it?`,
    false,
    true,
    { readMachineStdin: true },
  );
  if (!outcome.answered) return yield* requiredError(target, command);
  if (outcome.value && yes) yield* output.raw(`Seeding enabled by ${target.enabledBy}\n`, "stderr");
  return outcome.value;
});

/** The cancelled message both commands use when the seed prompt is answered no. */
export const SEED_CANCELLED_MESSAGE = "Seeding cancelled; nothing was changed.";

export const seedCancelledSuggestion = (command: SeedConsentCommand): string =>
  SEED_CONSENT_SUGGESTIONS[command];
