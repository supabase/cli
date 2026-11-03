import { Effect, FileSystem, Option, Path, Ref } from "effect";

import {
  DnsResolverFlag,
  resolveExperimentalWithProjectEnv,
  resolveYesWithProjectEnv,
} from "../../../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../../../command-internal/prompt-yes-no.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../../../config/command-settings.service.ts";
import {
  loadProjectEnvValues,
  readDbToml,
  resolveDeclarativeDir,
} from "../../../../../command-internal/db-config.toml-read.ts";
import { resolveTarget } from "../../../../../command-internal/target/resolve-target.ts";
import { LinkedProjectCache } from "../../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../../telemetry/telemetry-state.service.ts";
import { isPgDeltaDebugEnabled } from "../../../../../command-internal/pgdelta.ts";
import { DeclarativeWriteError } from "../../../shared/pgdelta.errors.ts";
import { warnFormerDeclarativeDefault } from "../declarative.former-default.ts";
import { requirePgDelta } from "../declarative.gate.ts";
import {
  type DeclarativeRunContext,
  generateDeclarativeOutput,
} from "../declarative.orchestrate.ts";
import {
  declarativeSchemaWrittenLine,
  warnPreservedUnmanagedDeclarativeFiles,
  writeDeclarativeSchemas,
} from "../../../shared/pgdelta.write.ts";
import type { DbSchemaDeclarativeGenerateFlags } from "./generate.command.ts";
import { prepareLocalTargetEndpoint, resolveTargetEndpoint } from "../declarative.smart-target.ts";

export const dbSchemaDeclarativeGenerate = Effect.fn("db.schema.declarative.generate")(function* (
  flags: DbSchemaDeclarativeGenerateFlags,
) {
  const output = yield* Output;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const dnsResolver = yield* DnsResolverFlag;
  // The project env is loaded and resolved before the gate below, so a `SUPABASE_EXPERIMENTAL`
  // set only in `supabase/.env` opens the gate too.
  const projectEnv = yield* loadProjectEnvValues(fs, path, cliSettings.workdir);
  const experimental = yield* resolveExperimentalWithProjectEnv(projectEnv);
  // `--yes` or `SUPABASE_YES` (shell env or project `.env`) must auto-confirm the prompts below.
  const yes = yield* resolveYesWithProjectEnv(projectEnv);

  // Hoisted so the post-run linked-project cache finalizer can read the ref the body resolves.
  const linkedProjectRef = yield* Ref.make<string | undefined>(undefined);

  yield* Effect.gen(function* () {
    const baseToml = yield* readDbToml(fs, path, cliSettings.workdir);
    // Gate on the base config: a remote `experimental.pgdelta.enabled = true` must not enable a
    // base-disabled command without `--experimental`.
    yield* requirePgDelta({
      experimental,
      pgDeltaEnabled: baseToml.pgDelta.enabled,
      configPath: path.join("supabase", "config.toml"),
    });

    const target = yield* resolveTarget(flags);

    // A linked target re-loads config with its ref, so a matching `[remotes.<ref>]` block
    // overrides `experimental.pgdelta.*` downstream only, not the gate above.
    let toml = baseToml;
    if (target.kind === "linked") {
      yield* Ref.set(linkedProjectRef, target.ref);
      toml = yield* readDbToml(fs, path, cliSettings.workdir, target.ref);
    }

    // Preserve the selected value for user-facing output: invocation-local `--output` wins,
    // otherwise the configured declarative path. File I/O resolves relative values from the
    // project workdir while keeping absolute values unchanged.
    const declarativeDirRel = Option.getOrElse(flags.outputDir, () =>
      resolveDeclarativeDir(path, toml.pgDelta),
    );
    const workdir = path.resolve(cliSettings.workdir);
    const declarativeDir = path.resolve(workdir, declarativeDirRel);
    const workdirFromOutput = path.relative(declarativeDir, workdir);
    const outputContainsWorkdir =
      workdirFromOutput.length === 0 ||
      (!path.isAbsolute(workdirFromOutput) &&
        workdirFromOutput !== ".." &&
        !workdirFromOutput.startsWith(`..${path.sep}`));
    if (declarativeDirRel.trim().length === 0 || outputContainsWorkdir) {
      return yield* new DeclarativeWriteError({
        message:
          "declarative output directory must not be empty, resolve to the project directory, or contain the project directory",
      });
    }
    yield* warnFormerDeclarativeDefault(fs, path, cliSettings.workdir, toml.pgDelta);
    const run: DeclarativeRunContext = {
      pgDelta: {
        projectId: toml.projectId,
        cwd: cliSettings.workdir,
        // The merged config's deno_version, so a linked run uses the remote-configured Deno image.
        denoVersion: toml.denoVersion,
        projectEnv: toml.projectEnv,
      },
      formatOptions: Option.getOrElse(toml.pgDelta.formatOptions, () => ""),
      declarativeDir,
      declarativeDirDisplay: declarativeDirRel,
      schema: flags.schema,
      noCache: flags.noCache,
      debug: yield* isPgDeltaDebugEnabled,
      strictCoverage: flags.strictCoverage,
      dnsResolver,
      ...(target.kind === "linked" ? { linkedProjectRef: target.ref } : {}),
    };

    yield* Effect.annotateCurrentSpan({
      "declarative.target": target.kind,
      "schema.count": flags.schema.length,
    });

    const endpoint =
      target.kind === "local"
        ? yield* prepareLocalTargetEndpoint(Effect.succeed(flags.reset), flags.password)
        : yield* resolveTargetEndpoint(target, flags.password, true);

    const result = yield* generateDeclarativeOutput(run, endpoint);

    if (!flags.overwrite && (yield* confirmOverwriteHasFiles(fs, declarativeDir))) {
      // `--yes`/`SUPABASE_YES` auto-confirms, but still echoes the `<label> [y/N] y` stderr line
      // via `promptYesNo` rather than skipping it.
      const ok = yield* promptYesNo(
        output,
        yes,
        "Overwrite declarative schema? Existing files may be deleted.",
        false,
      );
      if (!ok) {
        yield* output.raw("Skipped writing declarative schema.\n", "stderr");
        return;
      }
    }

    const written = yield* writeDeclarativeSchemas(fs, path, declarativeDir, result);
    // The overwrite prompt promises existing files may be deleted, but the writer only prunes
    // what an export manifest claimed, so say so when a manifest-less directory kept files.
    yield* warnPreservedUnmanagedDeclarativeFiles(declarativeDirRel, written);
    yield* output.raw(declarativeSchemaWrittenLine(declarativeDirRel), "stderr");
  }).pipe(
    // The cache layer no-ops when the file exists, the token is missing, or the GET is non-200.
    Effect.ensuring(
      Effect.flatMap(Ref.get(linkedProjectRef), (ref) =>
        ref !== undefined ? linkedProjectCache.cache(ref) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});

// An unreadable-but-existing declarative dir must abort rather than read as "empty" and get
// silently overwritten by `writeDeclarativeSchemas`; only a not-exist directory means "no
// confirmation needed", so any other `PlatformError` propagates unwrapped.
const confirmOverwriteHasFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  dir: string,
) {
  const entries = yield* fs
    .readDirectory(dir)
    .pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed<ReadonlyArray<string>>([]),
      ),
    );
  return entries.length > 0;
});
