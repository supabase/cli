import { Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyExperimentalFlag,
  LegacyYesFlag,
} from "../../../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../../../shared/output/output.service.ts";
import { Tty } from "../../../../../../shared/runtime/tty.service.ts";
import { LegacyCliConfig } from "../../../../../config/legacy-cli-config.service.ts";
import { legacyBold } from "../../../../../shared/legacy-colors.ts";
import { legacyReadProjectRefFile } from "../../../../../shared/legacy-temp-paths.ts";
import {
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "../../../../../shared/legacy-db-config.toml-read.ts";
import { LegacyLinkedProjectCache } from "../../../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyListLocalMigrations } from "../declarative.cache.ts";
import {
  LegacyDeclarativeMutuallyExclusiveFlagsError,
  LegacyDeclarativeNonInteractiveError,
} from "../declarative.errors.ts";
import { LegacyDeclarativeSeam } from "../declarative.seam.service.ts";
import { legacyRequirePgDelta } from "../declarative.gate.ts";
import {
  type LegacyDeclarativeRunContext,
  legacyGenerateDeclarativeOutput,
} from "../declarative.orchestrate.ts";
import { legacyWriteDeclarativeSchemas } from "../declarative.write.ts";
import type { LegacyDbSchemaDeclarativeGenerateFlags } from "./generate.command.ts";
import {
  type LegacyLocalConn,
  legacyLocalUrl,
  legacyResolveRemoteUrl,
  legacyResolveSmartTargetUrl,
} from "../declarative.smart-target.ts";

export const legacyDbSchemaDeclarativeGenerate = Effect.fn("legacy.db.schema.declarative.generate")(
  function* (flags: LegacyDbSchemaDeclarativeGenerateFlags) {
    const output = yield* Output;
    const tty = yield* Tty;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliConfig = yield* LegacyCliConfig;
    const telemetryState = yield* LegacyTelemetryState;
    const linkedProjectCache = yield* LegacyLinkedProjectCache;
    const experimental = yield* LegacyExperimentalFlag;
    const yes = yield* LegacyYesFlag;

    // The resolved linked ref (explicit `--linked` only), hoisted so the post-run
    // linked-project cache finalizer can read it after the body resolves it.
    let linkedProjectRef: string | undefined;

    yield* Effect.gen(function* () {
      // cobra `MarkFlagsMutuallyExclusive("db-url", "linked", "local")`
      // (`apps/cli-go/cmd/db_schema_declarative.go:499`) runs before PreRunE/RunE,
      // so reject conflicting targets before reading config or the pg-delta gate.
      // "Set" follows cobra's `Changed`: Option set when `Some`, boolean when `true`.
      const exclusive: Array<string> = [];
      if (Option.isSome(flags.dbUrl)) exclusive.push("db-url");
      if (Option.isSome(flags.linked)) exclusive.push("linked");
      if (Option.isSome(flags.local)) exclusive.push("local");
      if (exclusive.length > 1) {
        return yield* Effect.fail(
          new LegacyDeclarativeMutuallyExclusiveFlagsError({
            message: `if any flags in the group [db-url linked local] are set none of the others can be; [${exclusive.join(" ")}] were all set`,
          }),
        );
      }

      const baseToml = yield* legacyReadDbToml(fs, path, cliConfig.workdir);
      // The pg-delta gate runs on the BASE config: Go's declarative `PersistentPreRunE`
      // gates before the root `ParseDatabaseConfig` reloads any `[remotes.<ref>]` block,
      // so a remote `experimental.pgdelta.enabled = true` must NOT enable a
      // base-disabled command without `--experimental`.
      yield* legacyRequirePgDelta({
        experimental,
        pgDeltaEnabled: baseToml.pgDelta.enabled,
        configPath: path.join("supabase", "config.toml"),
      });

      // Explicit `--linked`: Go re-loads config with the resolved ref (root
      // `ParseDatabaseConfig` linked branch), so a matching `[remotes.<ref>]` block
      // overrides `experimental.pgdelta.*` (declarative_schema_path / format_options)
      // for the downstream path/format settings only — NOT the gate above. (Smart-mode
      // "Linked project" does NOT re-load in Go, so it is excluded — only `flags.linked`.)
      let toml = baseToml;
      // The resolved linked ref (explicit `--linked` only) is threaded into the
      // baseline `__catalog` export (so its platform baseline is built from the
      // remote-merged config, matching Go's `Generate`) and into the post-run
      // linked-project cache finalizer below.
      if (Option.isSome(flags.linked)) {
        const linkedRef = Option.isSome(cliConfig.projectId)
          ? cliConfig.projectId
          : yield* legacyReadProjectRefFile(fs, path, cliConfig.workdir);
        if (Option.isSome(linkedRef)) {
          linkedProjectRef = linkedRef.value;
          toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir, linkedRef.value);
        }
      }

      // `path.resolve` (not `path.join`) so an absolute `declarative_schema_path` is
      // used as-is: Go's config resolver only prefixes the workdir onto a RELATIVE path
      // (`config.resolve`), leaving an absolute path unchanged. `path.join(workdir, abs)`
      // would mangle `/repo` + `/abs` into `/repo/abs`.
      const declarativeDir = path.resolve(
        cliConfig.workdir,
        legacyResolveDeclarativeDir(path, toml.pgDelta),
      );
      const migrationsDir = path.join(cliConfig.workdir, "supabase", "migrations");
      const local: LegacyLocalConn = { port: toml.port, password: toml.password };

      const run: LegacyDeclarativeRunContext = {
        pgDelta: {
          projectId: Option.getOrElse(cliConfig.projectId, () => ""),
          cwd: cliConfig.workdir,
          npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
          // Merged config's deno_version (re-loaded with the linked ref above on
          // `--linked`), so pg-delta runs under the remote-configured Deno image.
          denoVersion: toml.denoVersion,
        },
        formatOptions: Option.getOrElse(toml.pgDelta.formatOptions, () => ""),
        declarativeDir,
        schema: flags.schema,
        noCache: flags.noCache,
        ...(linkedProjectRef !== undefined ? { linkedProjectRef } : {}),
      };

      const hasExplicitTarget =
        Option.isSome(flags.local) || Option.isSome(flags.linked) || Option.isSome(flags.dbUrl);

      let targetUrl: string;
      let overwrite: boolean;
      if (hasExplicitTarget) {
        if (Option.isSome(flags.local)) {
          // Target selection keys off flag presence (Go's `Changed`), but the
          // auto-start gates on the boolean VALUE: Go passes `declarativeLocal` to
          // `ensureLocalDatabaseStarted` (`db_schema_declarative.go:190`), which
          // short-circuits `if !local { return nil }` (`:127-128`). So `--local=false`
          // selects the local target but must NOT start a stopped stack.
          if (Option.getOrElse(flags.local, () => false)) {
            yield* (yield* LegacyDeclarativeSeam).ensureLocalDatabaseStarted();
          }
          targetUrl = legacyLocalUrl(local);
        } else {
          targetUrl = yield* legacyResolveRemoteUrl(flags);
        }
        overwrite = flags.overwrite;
      } else {
        if (!tty.stdinIsTty && !yes) {
          return yield* Effect.fail(
            new LegacyDeclarativeNonInteractiveError({
              message: "in non-interactive mode, specify a target: --local, --linked, or --db-url",
            }),
          );
        }
        if ((yield* hasDeclarativeFiles(fs, declarativeDir)) && !flags.overwrite) {
          // Go asks via Console.PromptYesNo (db_schema_declarative.go:208, default
          // false), which auto-returns true under the global --yes flag, so --yes
          // regenerates without prompting instead of blocking in non-interactive mode.
          const ok = yes
            ? true
            : yield* output.promptConfirm(
                `Declarative schema already exists at ${legacyBold(
                  declarativeDir,
                )}. Regenerate from database? This will overwrite existing files.`,
                { defaultValue: false },
              );
          if (!ok) {
            yield* output.raw("Skipped generating declarative schema.\n", "stderr");
            return;
          }
        }
        const hasMigrations = yield* hasMigrationFiles(fs, path, migrationsDir);
        // Go's `runDeclarativeGenerate` calls `flags.LoadProjectRef` ONLY inside the
        // `hasMigrationFiles` branch (`db_schema_declarative.go:219-224`): it offers a
        // "Linked project" choice when the workdir is linked, and that `LoadProjectRef`
        // sets the global `flags.ProjectRef`, so root `ensureProjectGroupsCached` writes
        // the linked-project cache/groups regardless of which target the user then picks
        // (`cmd/root.go:176,214-218`). Resolve the ref the same way the resolver's
        // `--linked` branch does (config `project_id` → `.temp/project-ref`) — only when
        // migrations exist (matching Go's placement; no read in the no-migrations path) —
        // and record it for the post-run cache finalizer so smart generate in a linked
        // workdir caches like Go even when the user chooses local/custom.
        let linkedRef = Option.none<string>();
        if (hasMigrations) {
          // Smart prompt only decides whether to OFFER the linked choice — Go guards
          // this `LoadProjectRef` with `if err == nil` (`db_schema_declarative.go:222-224`),
          // ignoring read/validation errors and proceeding with local/custom. So swallow
          // a broken `.temp/project-ref` here (omit the linked choice) rather than
          // aborting; the explicit `--linked` branch above keeps propagating (hard path).
          linkedRef = Option.isSome(cliConfig.projectId)
            ? cliConfig.projectId
            : yield* legacyReadProjectRefFile(fs, path, cliConfig.workdir).pipe(
                Effect.orElseSucceed(() => Option.none<string>()),
              );
          if (Option.isSome(linkedRef)) {
            linkedProjectRef = linkedRef.value;
          }
        }
        targetUrl = yield* legacyResolveSmartTargetUrl(
          flags,
          local,
          hasMigrations,
          fs,
          path,
          cliConfig.workdir,
          linkedRef,
        );
        overwrite = true;
      }

      const result = yield* legacyGenerateDeclarativeOutput(run, targetUrl);

      if (!overwrite && (yield* confirmOverwriteHasFiles(fs, declarativeDir))) {
        // Go's confirmOverwrite goes through Console.PromptYesNo, which returns true
        // immediately when the global YES flag is set (`apps/cli-go/internal/utils/
        // console.go:70-73`). Honor --yes here too, or non-interactive/JSON runs
        // would error on the prompt and a TTY would block despite --yes.
        const ok = yes
          ? true
          : yield* output.promptConfirm(
              "Overwrite declarative schema? Existing files may be deleted.",
              { defaultValue: false },
            );
        if (!ok) {
          yield* output.raw("Skipped writing declarative schema.\n", "stderr");
          return;
        }
      }

      yield* legacyWriteDeclarativeSchemas(fs, path, declarativeDir, result);

      // Warm the declarative catalog cache after writing the files and before the
      // success message, gated on `!--no-cache` — Go's `Generate`
      // (`apps/cli-go/internal/db/declarative/declarative.go:133-157`). This applies
      // the generated schema to the shadow DB and caches the catalog under the
      // `local` key a subsequent `sync` reuses; a schema that cannot be applied makes
      // `generate` fail here rather than succeeding and forcing `sync` to reprovision.
      //
      // On explicit `--linked`, thread the resolved ref as `SUPABASE_PROJECT_ID` into the
      // `__catalog` subprocess (the same channel the baseline export uses), so it loads
      // the `[remotes.<ref>]`-merged config and its own `GetDeclarativeDir()` resolves the
      // remote-overridden `declarative_schema_path` — i.e. the warm builds from the same
      // merged config and targets the same dir the handler wrote to (also computed from
      // the merged `toml`). Go warms against the in-process merged config identically
      // (`declarative.go:138-154`), so this always runs when `!--no-cache`.
      if (!flags.noCache) {
        yield* (yield* LegacyDeclarativeSeam).exportCatalog({
          mode: "declarative",
          noCache: flags.noCache,
          ...(linkedProjectRef !== undefined ? { projectRef: linkedProjectRef } : {}),
        });
      }
      yield* output.raw(`Declarative schema written to ${legacyBold(declarativeDir)}\n`, "stderr");
    }).pipe(
      // Go's `ensureProjectGroupsCached` PersistentPostRun (`cmd/root.go:176,214-234`)
      // writes the linked-project cache (`GET /v1/projects/{ref}` →
      // `supabase/.temp/linked-project.json`) for any resolved ref, on success and
      // failure. Only explicit `--linked` resolves a ref here (Go gates on
      // `flags.ProjectRef != ""`); the cache layer no-ops when the file exists, the
      // token is missing, or the GET is non-200. Read the ref lazily — it is assigned
      // inside the body above.
      Effect.ensuring(
        Effect.suspend(() =>
          linkedProjectRef !== undefined ? linkedProjectCache.cache(linkedProjectRef) : Effect.void,
        ),
      ),
      Effect.ensuring(telemetryState.flush),
    );
  },
);

const hasDeclarativeFiles = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, dir: string) {
  const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return false;
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
  return entries.length > 0;
});

// The overwrite-confirmation guard, mirroring Go's `confirmOverwrite`
// (`apps/cli-go/internal/db/declarative/declarative.go:220-235`). Unlike the
// smart-mode `hasDeclarativeFiles` above (which matches `cmd.hasDeclarativeFiles`
// and swallows read errors), `confirmOverwrite` returns the `ReadDir` error and
// `Generate` aborts on it (`declarative.go:123-127`). So an unreadable-but-existing
// declarative dir must abort here rather than read as "empty" and get silently
// overwritten by `legacyWriteDeclarativeSchemas`. Only a not-exist directory means
// "no confirmation needed"; Go returns the raw error, so let the `PlatformError`
// propagate unwrapped.
const confirmOverwriteHasFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  dir: string,
) {
  const entries = yield* fs
    .readDirectory(dir)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed<ReadonlyArray<string>>([])
          : Effect.fail(error),
      ),
    );
  return entries.length > 0;
});

const hasMigrationFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) {
  // Smart-mode presence/prompt probe only: mirror Go's `cmd.hasMigrationFiles`
  // (`db_schema_declarative.go:164-169`), which wraps `migration.ListLocalMigrations`
  // and returns `false` on EVERY error (unreadable dir, path-is-a-file, …), not just
  // not-exist — so generate continues into the no-migrations local flow. The real diff
  // path keeps `legacyListLocalMigrations`' hard error behavior (Go `declarative.go:369`).
  const migrations = yield* legacyListLocalMigrations(fs, path, migrationsDir).pipe(
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
  );
  return migrations.length > 0;
});
