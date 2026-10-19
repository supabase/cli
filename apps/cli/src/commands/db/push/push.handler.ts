import { Effect, FileSystem, Option, Path, Ref } from "effect";

import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { CliConfigValues } from "../../../config/cli-config-values.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { checkDbToml } from "../../../command-internal/db-config.toml-read.ts";
import { dbPushCore } from "../../../command-internal/db-push-core.ts";
import { hostedMutationPreapproval } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { planDbSeed } from "../../../command-internal/seed-remote-consent.ts";
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { flagsForTarget } from "../../../command-internal/target/target-flags.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { DbPushFlags } from "./push.command.ts";

/**
 * `supabase db push` — apply pending local migrations (and optionally seed data
 * and custom roles) to the linked project, or to the database `--local` / `--db-url` selects.
 *
 * Resolves the target and `config.toml`, then delegates the push to `dbPushCore`, shared with
 * `bootstrap`, which asks one combined consent once the plan is known.
 */
export const dbPush = Effect.fn("db.push")(function* (flags: DbPushFlags) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;
  const configValues = yield* CliConfigValues;

  const workdir = cliSettings.workdir;
  const linkedRefForCache = yield* Ref.make<string | undefined>(undefined);

  const body = Effect.gen(function* () {
    const target = yield* resolveTarget(flags);
    const projectRef = target.kind === "linked" ? target.ref : "";
    if (target.kind === "linked") yield* Ref.set(linkedRefForCache, projectRef);

    // Single config load (except `--skip-vault`, which omits `[db.vault]` secret
    // resolution): decodes with env-expansion + weak-typed booleans, applies
    // `SUPABASE_*` overrides, merges a matching `[remotes.<ref>]` block, and decrypts
    // `encrypted:` secrets — aborting here on any invalid config, before the
    // connection's network activity, so a remote override prints first.
    const toml = yield* checkDbToml(fs, path, workdir, projectRef !== "" ? projectRef : undefined, {
      resolveVaultSecrets: !flags.skipVault,
    });
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }
    const resolvedConfig = yield* configValues.load({
      workdir,
      projectRef: projectRef !== "" ? Option.some(projectRef) : Option.none(),
    });
    const seed = yield* planDbSeed(resolvedConfig, { workdir, ref: projectRef });
    const includeSeed = Option.getOrElse(flags.includeSeed, () => false);

    const cfg = yield* resolver.resolveConnection({
      target,
      dnsResolver,
      password: flags.password,
      resolveVaultSecrets: !flags.skipVault,
      hasPasswordFlag: true,
      networkBanRemoval: yield* hostedMutationPreapproval,
    });

    yield* Effect.annotateCurrentSpan({
      "db.conn_type": target.kind,
      "db.is_local": cfg.isLocal,
      "db.push.dry_run": flags.dryRun,
      "db.push.include_all": flags.includeAll,
      "db.push.include_roles": flags.includeRoles,
      "db.push.include_seed": includeSeed,
    });

    yield* dbPushCore({
      workdir,
      projectRef,
      conn: cfg.conn,
      isLocal: cfg.isLocal,
      repairTargetFlags: flagsForTarget(target),
      dryRun: flags.dryRun,
      includeAll: flags.includeAll,
      includeRoles: flags.includeRoles,
      includeSeed,
      seed,
      includeVault: !flags.skipVault,
      dnsResolver,
      toml,
      preapproved: Option.none(),
      emitStructuredResult: true,
    });
  });

  yield* body.pipe(
    Effect.ensuring(
      Effect.flatMap(Ref.get(linkedRefForCache), (ref) =>
        ref !== undefined && ref !== "" ? linkedProjectCache.cache(ref) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
    Effect.scoped,
  );
});
