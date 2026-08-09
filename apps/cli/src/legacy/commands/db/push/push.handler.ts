import { Effect, FileSystem, Option, Path } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { legacyResolveYesWithProjectEnv } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  legacyApplyProjectEnv,
  legacyCheckDbToml,
  legacyLoadProjectEnv,
} from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyDbPushCore } from "../../../shared/legacy-db-push-core.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyDbPushFlags } from "./push.command.ts";
import { LegacyDbPushTargetFlagsError } from "./push.errors.ts";

/**
 * `supabase db push` — apply pending local migrations (and optionally seed data
 * and custom roles) to the local or linked/remote database.
 *
 * Resolves the `--db-url`/`--linked`/`--local` target and `config.toml` (Go's
 * root `PersistentPreRunE` → `ParseDatabaseConfig`), then delegates the actual
 * push to `legacyDbPushCore` (Go's `push.Run`), shared with `bootstrap`.
 */
export const legacyDbPush = Effect.fn("legacy.db.push")(function* (flags: LegacyDbPushFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliArgs = yield* CliArgs;
  const dnsResolver = yield* LegacyDnsResolverFlag;

  const workdir = cliConfig.workdir;
  // Go's `ParseDatabaseConfig` runs `loadNestedEnv` (which `os.Setenv`s each project-`.env`
  // key) before `PromptYesNo` reads `viper.GetBool("YES")`, so a `SUPABASE_YES` set only in
  // `supabase/.env` auto-confirms. Resolve `yes` with that project env, as `db pull` does.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);
  let linkedRefForCache: string | undefined;

  const body = Effect.gen(function* () {
    yield* legacyApplyProjectEnv(projectEnv);
    const target = resolveLegacyDbTargetFlags(cliArgs.args);
    // cobra MarkFlagsMutuallyExclusive("db-url", "linked", "local"), keyed off the
    // explicitly-set flags (cobra's `Changed`), not the `--linked` default value.
    if (target.setFlags.length > 1) {
      return yield* Effect.fail(
        new LegacyDbPushTargetFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
        }),
      );
    }
    // Go's push defaults `--linked` to true, so no target flag → linked.
    const connType = target.connType ?? "linked";

    // The linked path resolves the project ref before loading config so a matching
    // `[remotes.<ref>]` block merges (Go's ParseDatabaseConfig → LoadConfig). For
    // `--local` / `--db-url`, Go leaves `flags.ProjectRef` empty.
    let projectRef = "";
    if (connType === "linked") {
      const refResolver = yield* LegacyProjectRefResolver;
      projectRef = yield* refResolver.loadProjectRef(Option.none());
      linkedRefForCache = projectRef;
    }

    // Single Go-parity config load (`flags.LoadConfig` → `config.Load` + `Validate`),
    // except that `--skip-vault` omits only `[db.vault]` secret resolution:
    // decodes the whole config with Go's env-expansion + `strconv.ParseBool` weak typing
    // (so `enabled = "env(SEED_ENABLED)"` etc. load like Go), applies `SUPABASE_*`
    // AutomaticEnv overrides, merges a matching `[remotes.<ref>]` block, and decrypts selected
    // `encrypted:` secrets with the shell AND project-`.env` `DOTENV_PRIVATE_KEY*` keys —
    // aborting here (before connecting or writing) on any undecryptable/invalid config.
    // This must resolve BEFORE `resolver.resolve()`'s network activity (temp-role minting,
    // pooler fallback) so a matching `[remotes.<ref>]` override prints before it, matching
    // Go's root `PersistentPreRunE` resolving config before `push.Run` even starts.
    const toml = yield* legacyCheckDbToml(
      fs,
      path,
      workdir,
      projectRef !== "" ? projectRef : undefined,
      { resolveVaultSecrets: !flags.skipVault },
    );
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }

    const cfg = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      password: flags.password,
      resolveVaultSecrets: !flags.skipVault,
    });

    yield* legacyDbPushCore({
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
      projectId: cliConfig.projectId,
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
