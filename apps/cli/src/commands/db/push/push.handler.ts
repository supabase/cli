import { Effect, FileSystem, Option, Path } from "effect";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { resolveYesWithProjectEnv } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import {
  applyProjectEnv,
  checkDbToml,
  loadProjectEnv,
} from "../../../command-internal/db-config.toml-read.ts";
import { dbPushCore } from "../../../command-internal/db-push-core.ts";
import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { DbPushFlags } from "./push.command.ts";
import { DbPushTargetFlagsError } from "./push.errors.ts";

/**
 * `supabase db push` — apply pending local migrations (and optionally seed data
 * and custom roles) to the local or linked/remote database.
 *
 * Resolves the `--db-url`/`--linked`/`--local` target and `config.toml`, then
 * delegates the actual push to `dbPushCore`, shared with `bootstrap`.
 */
export const dbPush = Effect.fn("db.push")(function* (flags: DbPushFlags) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliArgs = yield* CliArgs;
  const dnsResolver = yield* DnsResolverFlag;

  const workdir = cliSettings.workdir;
  // The project `.env` is applied before the history prompt, so a
  // `SUPABASE_YES` set only in `supabase/.env` auto-confirms. Resolve `yes`
  // with that project env, as `db pull` does.
  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);
  let linkedRefForCache: string | undefined;

  const body = Effect.gen(function* () {
    yield* applyProjectEnv(projectEnv);
    const target = resolveDbTargetFlags(cliArgs.args);
    // Mutually-exclusive db-url/linked/local group, keyed off the
    // explicitly-set flags, not the `--linked` default value.
    if (target.setFlags.length > 1) {
      return yield* Effect.fail(
        new DbPushTargetFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
        }),
      );
    }
    // push defaults `--linked` to true, so no target flag → linked.
    const connType = target.connType ?? "linked";

    // TS-only guard: `--project-ref` never implies `--linked` and must not be
    // silently discarded on a non-linked target. Deliberately STRICTER than the
    // `SUPABASE_PROJECT_ID` env var, which is read unconditionally but simply
    // goes unused (no error) on a `--local`/`--db-url` target — an explicitly
    // typed `--project-ref` flag silently doing nothing on e.g. `db push
    // --local` is a footgun the env var doesn't share, so this errors instead.
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* Effect.fail(
        new DbPushTargetFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        }),
      );
    }

    // The linked path resolves the project ref before loading config so a
    // matching `[remotes.<ref>]` block merges. For `--local` / `--db-url`,
    // the ref stays empty.
    let projectRef = "";
    if (connType === "linked") {
      const refResolver = yield* ProjectRefResolver;
      projectRef = yield* refResolver.loadProjectRef(flags.projectRef);
      linkedRefForCache = projectRef;
    }

    // Single config load, except that `--skip-vault` omits only `[db.vault]`
    // secret resolution: decodes the whole config with env-expansion +
    // weak-typed boolean parsing (so `enabled = "env(SEED_ENABLED)"` etc.
    // load), applies `SUPABASE_*` env overrides, merges a matching
    // `[remotes.<ref>]` block, and decrypts selected `encrypted:` secrets
    // with the shell AND project-`.env` `DOTENV_PRIVATE_KEY*` keys — aborting
    // here (before connecting or writing) on any undecryptable/invalid
    // config. This must resolve BEFORE `resolver.resolve()`'s network
    // activity (temp-role minting, pooler fallback) so a matching
    // `[remotes.<ref>]` override prints before it.
    const toml = yield* checkDbToml(fs, path, workdir, projectRef !== "" ? projectRef : undefined, {
      resolveVaultSecrets: !flags.skipVault,
    });
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }

    const cfg = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      password: flags.password,
      resolveVaultSecrets: !flags.skipVault,
      linkedProjectRef: flags.projectRef,
    });

    yield* dbPushCore({
      workdir,
      projectRef,
      conn: cfg.conn,
      isLocal: cfg.isLocal,
      repairSuggestsLocalFlag: connType === "local",
      dryRun: flags.dryRun,
      includeAll: flags.includeAll,
      includeRoles: flags.includeRoles,
      includeSeed: flags.includeSeed,
      includeVault: !flags.skipVault,
      dnsResolver,
      toml,
      yes,
      emitStructuredResult: true,
    });
  });

  yield* body.pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        linkedRefForCache !== undefined && linkedRefForCache !== ""
          ? linkedProjectCache.cache(linkedRefForCache)
          : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
    Effect.scoped,
  );
});
