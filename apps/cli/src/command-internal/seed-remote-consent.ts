import { Effect, Option, Path, Predicate } from "effect";

import { CliConfigKeys } from "../config/cli-config-keys.ts";
import { describeCliConfigOrigin } from "../config/cli-config-key.ts";
import type { ResolvedCliConfig } from "../config/cli-config-values.service.ts";

/** A seed run whose target matched a `[remotes.*]` block that did not turn seeding on itself. */
interface SeedConsentTarget {
  readonly ref: string;
  readonly remote: string;
  /** What turned seeding on, as `describeCliConfigOrigin` words it. */
  readonly enabledBy: string;
}

/** The effective `[db.seed]` values a command acts on, plus the remote that did not enable them. */
interface DbSeedInput {
  readonly enabled: boolean;
  readonly sqlPaths: ReadonlyArray<string>;
  readonly consent: SeedConsentTarget | undefined;
}

/** The seed input plus the line a hosted-mutation consent shows for the files a run would seed. */
export interface DbSeedPlan {
  readonly input: DbSeedInput;
  /** `undefined` when seeding is off or `files` is empty. */
  readonly detail: (files: ReadonlyArray<string>) => string | undefined;
}

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

/** Reads `[db.seed]` through the resolved config; the caller's single consent carries {@link DbSeedPlan.detail}. */
export const planDbSeed = Effect.fn("DbSeedPlan.plan")(function* (
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
  const input: DbSeedInput = { enabled: enabled.value, sqlPaths: sqlPaths.value, consent };
  return {
    input,
    detail: (files) => {
      if (!input.enabled || files.length === 0) return undefined;
      const noun = files.length === 1 ? "file" : "files";
      const into = remote === undefined ? "" : ` into [remotes.${remote}]`;
      const enabledBy = consent === undefined ? "" : ` (seeding enabled by ${consent.enabledBy})`;
      return `seed ${files.length} ${noun}${into}${enabledBy}`;
    },
  } satisfies DbSeedPlan;
});
