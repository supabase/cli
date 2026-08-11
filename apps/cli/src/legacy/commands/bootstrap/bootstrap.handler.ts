import { Effect, FileSystem, Option, Path, Schedule } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { LegacyPlatformApi } from "../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import {
  LegacyDnsResolverFlag,
  LegacyWorkdirFlag,
  legacyResolveYes,
  legacyResolveYesWithProjectEnv,
} from "../../../shared/legacy/global-flags.ts";
import {
  emitSuccessTrailer,
  setSuccessWorkingDirectory,
} from "../../../shared/cli/success-trailer.ts";
import { legacyPromptYesNo } from "../../../shared/legacy/legacy-prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../shared/output/errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { legacyAqua, legacyBold } from "../../shared/legacy-colors.ts";
import { legacyEnsureLogin } from "../../shared/legacy-ensure-login.ts";
import { legacyGetProjectApiKeys } from "../../shared/legacy-get-api-keys.ts";
import { sanitizeLegacyErrorBody } from "../../shared/legacy-http-errors.ts";
import type { LegacyConnectSuggestionContext } from "../../shared/legacy-connect-errors.ts";
import { legacyResolveLinkedConn } from "../../shared/legacy-db-config.layer.ts";
import {
  legacyApplyProjectEnv,
  legacyCheckDbToml,
  legacyLoadProjectEnv,
} from "../../shared/legacy-db-config.toml-read.ts";
import { legacyDbPushCore } from "../../shared/legacy-db-push-core.ts";
import { legacyLinkServicesCore } from "../../shared/legacy-link-services-core.ts";
import { legacyProjectCreateCore } from "../../shared/legacy-project-create-core.ts";
import { legacyTempPaths } from "../../shared/legacy-temp-paths.ts";
import { legacyExtractServiceKeys } from "../../shared/legacy-tenant-keys.ts";
import { parseDotEnv } from "../../shared/legacy-dotenv.ts";
import { initProject } from "../../../shared/init/project-init.ts";
import { buildDotEnv, marshalDotEnv } from "./bootstrap.dotenv.ts";
import {
  LegacyBootstrapHealthError,
  LegacyBootstrapInvalidTemplateError,
  LegacyBootstrapOverwriteDeclinedError,
  LegacyBootstrapWorkdirReadError,
} from "./bootstrap.errors.ts";
import { deriveDbConfig } from "./bootstrap.pgconfig.ts";
import { suggestAppStart } from "./bootstrap.suggest.ts";
import {
  LEGACY_BOOTSTRAP_MAX_RETRIES,
  legacyBootstrapBackoff,
  legacyBootstrapRetryNotify,
} from "./bootstrap.retry.ts";
import { type LegacyStarterTemplate, LegacyTemplateService } from "./bootstrap.templates.ts";
import type { LegacyBootstrapFlags } from "./bootstrap.command.ts";

// Go's built-in starter (`cmd/bootstrap.go:17-21`).
const SCRATCH_TEMPLATE: LegacyStarterTemplate = {
  name: "scratch",
  description: "An empty project from scratch.",
  url: "",
  start: "supabase start",
};

export const legacyBootstrap = Effect.fn("legacy.bootstrap")(function* (
  flags: LegacyBootstrapFlags,
  retrySchedule: Schedule.Schedule<unknown> = legacyBootstrapBackoff,
) {
  const output = yield* Output;
  const tty = yield* Tty;
  const runtimeInfo = yield* RuntimeInfo;
  const cliConfig = yield* LegacyCliConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const templateService = yield* LegacyTemplateService;
  const api = yield* LegacyPlatformApi;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const workdirFlag = yield* LegacyWorkdirFlag;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  // `--yes` OR `SUPABASE_YES` (Go's viper AutomaticEnv, root.go:318-320).
  const yesFlag = yield* legacyResolveYes;

  const isText = output.format === "text";
  const retry = { schedule: retrySchedule, times: LEGACY_BOOTSTRAP_MAX_RETRIES } as const;

  // `process.chdir` mirrors Go's `ChangeWorkDir`; restore the original cwd in a
  // finalizer so the surrounding process is left untouched once this command
  // returns (every step below reads its own explicit `workdir` var, never
  // `process.cwd()`, so nothing else depends on the chdir staying in effect).
  const originalCwd = process.cwd();
  let createdRef: string | undefined;
  // Resolved bootstrap workdir, hoisted so the linked-project-cache finalizer writes
  // beside the other `supabase/.temp/` files instead of `cliConfig.workdir`. Go achieves
  // this by re-running `flags.LoadConfig` after `ChangeWorkDir` (`bootstrap.go:98-100`).
  let resolvedWorkdir: string | undefined;

  yield* Effect.gen(function* () {
    // A. Resolve workdir (flag -> env -> prompt -> cwd). `bootstrap.go:30-40`.
    // Go's viper uses `SetEnvPrefix("SUPABASE")`, so `viper.IsSet("WORKDIR")` reads
    // the prefixed `SUPABASE_WORKDIR` only (never plain `WORKDIR`).
    const workdirRaw = Option.isSome(workdirFlag)
      ? workdirFlag.value
      : process.env["SUPABASE_WORKDIR"];
    const workdirInput =
      workdirRaw ??
      (yield* output.promptText(
        `Enter a directory to bootstrap your project (or leave blank to use ${legacyBold(
          runtimeInfo.cwd,
        )}): `,
      ));
    const workdir = path.isAbsolute(workdirInput)
      ? workdirInput
      : path.join(runtimeInfo.cwd, workdirInput);
    resolvedWorkdir = workdir;

    // B. List templates + resolve the starter. `bootstrap.go:38-58` / `cmd:25-58`.
    const samples = yield* templateService.listSamples;
    const allTemplates = [...samples, SCRATCH_TEMPLATE];
    let starter: LegacyStarterTemplate;
    if (Option.isSome(flags.template)) {
      const name = flags.template.value;
      const match = allTemplates.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (match === undefined) {
        return yield* new LegacyBootstrapInvalidTemplateError({
          message: `Invalid template: ${name}`,
        });
      }
      starter = match;
    } else {
      const choice = yield* output.promptSelect(
        "Which starter template do you want to use?",
        allTemplates.map((t) => ({ value: t.name, label: t.name, hint: t.description })),
      );
      starter = allTemplates.find((t) => t.name === choice) ?? SCRATCH_TEMPLATE;
    }

    // C. mkdir + overwrite prompt. `bootstrap.go:41-53`.
    yield* fs.makeDirectory(workdir, { recursive: true });
    const entries = yield* fs
      .readDirectory(workdir)
      .pipe(
        Effect.mapError(
          (cause) =>
            new LegacyBootstrapWorkdirReadError({ message: `failed to read workdir: ${cause}` }),
        ),
      );
    if (entries.length > 0) {
      // Go's `PromptYesNo(title, true)` (`bootstrap.go:47-48`, `console.go:64-82`):
      // `--yes`/`SUPABASE_YES` auto-confirms with the `<title> [Y/n] y` stderr echo
      // instead of silently skipping the prompt, and a non-TTY stdin scans one
      // piped line (100ms) before falling back to the Yes default (CLI-1974).
      const overwrite = yield* legacyPromptYesNo(
        output,
        yesFlag,
        `Do you want to overwrite existing files in ${legacyBold(workdir)} directory?`,
        true,
      );
      if (!overwrite) {
        return yield* new LegacyBootstrapOverwriteDeclinedError({
          message: CONTEXT_CANCELED_MESSAGE,
        });
      }
    }

    // D. chdir + "Using workdir" to stderr. `bootstrap.go:54` + `misc.go:240-247`.
    // Go only prints the line when the resolved workdir differs from the original
    // cwd (`cwd != CurrentDirAbs`); match that guard.
    yield* Effect.sync(() => process.chdir(workdir));
    if (workdir !== runtimeInfo.cwd) {
      yield* output.raw(`Using workdir ${legacyBold(workdir)}\n`, "stderr");
    }

    // E. Download template OR scaffold a blank project. `bootstrap.go:57-65`.
    if (starter.url.length > 0) {
      if (isText) yield* output.raw(`Downloading: ${starter.url}\n`, "stdout");
      yield* templateService.download(starter.url, workdir);
    } else {
      yield* initProject({
        cwd: workdir,
        force: true,
        interactive: false,
        yes: yesFlag,
        useOrioledb: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      });
    }

    // F. Ensure login (browser flow when no token). `bootstrap.go:66-77`.
    yield* legacyEnsureLogin({ openBrowser: tty.stdinIsTty });

    // G. Create project (echoes via the shared create core). `bootstrap.go:78-87`.
    // Go binds `-p` to viper `DB_PASSWORD`; with the `SUPABASE` env prefix the env
    // fallback is `SUPABASE_DB_PASSWORD` (consumed by `flags.PromptPassword`).
    const seededPassword = Option.isSome(flags.password)
      ? flags.password.value
      : (process.env["SUPABASE_DB_PASSWORD"] ?? "");
    const created = yield* legacyProjectCreateCore({
      name: path.basename(workdir),
      orgId: "",
      dbPassword: seededPassword,
      region: undefined,
      size: undefined,
      highAvailability: undefined,
      templateUrl: starter.url.length > 0 ? starter.url : undefined,
      emitStructuredResult: false,
    });
    const projectRef = created.ref;
    createdRef = projectRef.length > 0 ? projectRef : undefined;

    // H. Fetch api keys with backoff; each attempt prints "Linking project...".
    // `bootstrap.go:88-97`. The notify wrapper reproduces Go's `NewErrorCallback`
    // (`<err>\nRetry (n/8):` after each failed attempt); a fresh counter per block.
    const apiKeysNotify = legacyBootstrapRetryNotify();
    const keys = yield* Effect.gen(function* () {
      if (isText) yield* output.raw("Linking project...\n", "stderr");
      return yield* legacyGetProjectApiKeys(projectRef);
    }).pipe(apiKeysNotify, Effect.retry(retry));
    const { anon } = legacyExtractServiceKeys(keys);

    // I. Load config.toml + link services (best-effort, anon key) + mandatory
    // project-ref write. `bootstrap.go:98-105`: Go's `flags.LoadConfig(fsys)`
    // (`bootstrap.go:99`) runs FIRST — right before `link.LinkServices` — and a
    // malformed config.toml aborts bootstrap here (a hard `return err`), before
    // `link.LinkServices`, the health poll, or the `.env` write ever run. This
    // also fixes the "Loading config override: [remotes.x]" print's position to
    // match Go. `legacyApplyProjectEnv`'s scope (mirroring Go's process-lifetime
    // `os.Setenv`) is opened here and stays open for the rest of the handler —
    // see the `Effect.scoped` on this function's own outer pipe below.
    const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
    yield* legacyApplyProjectEnv(projectEnv);
    const pushYes = yield* legacyResolveYesWithProjectEnv(projectEnv);
    const toml = yield* legacyCheckDbToml(fs, path, workdir, projectRef);
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }

    yield* legacyLinkServicesCore({
      ref: projectRef,
      serviceKey: anon,
      skipPooler: false,
      workdir,
    });
    const paths = legacyTempPaths(path, workdir);
    yield* fs.makeDirectory(path.dirname(paths.projectRef), { recursive: true });
    yield* fs.writeFileString(paths.projectRef, projectRef);

    // J. Poll health until db is healthy. `bootstrap.go:106-113`.
    const healthNotify = legacyBootstrapRetryNotify();
    yield* Effect.gen(function* () {
      if (isText) yield* output.raw("Checking project health...\n", "stderr");
      const services = yield* api.v1
        .getServicesHealth({ ref: projectRef, services: ["db"] })
        .pipe(Effect.catch(mapHealthError));
      for (const service of services) {
        if (!service.healthy) {
          return yield* new LegacyBootstrapHealthError({
            message: `Service not healthy: ${service.name} (${service.status})`,
          });
        }
      }
    }).pipe(healthNotify, Effect.retry(retry));

    // K. Derive db config + write .env (non-fatal). `bootstrap.go:114-121`. Kept
    // as the naive direct-host connection (matching Go's `NewDbConfigWithPassword`
    // shape, minus its own IPv6/pooler-fallback — a pre-existing, out-of-scope
    // `.env` divergence: unlike step L below, `.env` is never used to actually
    // connect, so it doesn't need the real probe+fallback resolution).
    const dbConfig = deriveDbConfig(projectRef, created.dbPassword, cliConfig.projectHost);
    const supabaseUrl = `https://${projectRef}.${cliConfig.projectHost}`;
    const envFilePath = path.join(workdir, ".env");
    let envFileWritten = true;
    yield* Effect.gen(function* () {
      const examplePath = path.join(workdir, ".env.example");
      const hasExample = yield* fs.exists(examplePath);
      let example: Record<string, string> | undefined;
      if (hasExample) {
        const content = yield* fs.readFileString(examplePath);
        example = yield* Effect.try({
          try: () => parseDotEnv(content),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
      }
      const env = buildDotEnv(keys, dbConfig, supabaseUrl, example);
      yield* fs.writeFileString(envFilePath, marshalDotEnv(env));
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          envFileWritten = false;
          yield* output.raw(
            `Failed to create .env file: ${cause instanceof Error ? cause.message : String(cause)}\n`,
            "stderr",
          );
        }),
      ),
    );

    // L. Push migrations — native call to `legacyDbPushCore` (CLI-1953). Mirrors
    // Go's `push.Run(ctx, false, false, true, true, config, fsys)`
    // (`bootstrap.go:122-127`) => `includeAll: false, includeRoles: true,
    // includeSeed: true, dryRun: false`.
    //
    // The connection itself is resolved via `legacyResolveLinkedConn` — the same
    // dial-direct-host / fall-back-to-IPv4-pooler logic Go's
    // `flags.NewDbConfigWithPassword` uses (`db_url.go:132-172`), not the naive
    // `deriveDbConfig` used for `.env` above. New Supabase projects commonly have
    // an IPv6-only direct DB host, so without this fallback the push would burn
    // all 9 retries and fail on IPv4-only networks — the exact regression this
    // fix closes. `created.dbPassword` is always non-empty by this point (the
    // create step already prompted for/generated one), so — matching Go — the
    // temp-login-role branches are never actually reached; only the TCP probe
    // and a read of the `<workdir>/supabase/.temp/pooler-url` file `link.LinkServices`
    // already wrote in step I. Matching Go's own leniency here: given a non-empty
    // password, the only reachable failure is the direct host being unreachable
    // with no saved pooler URL yet (`LegacyDbConfigIpv6Error`) — Go's
    // `NewDbConfigWithPassword` still returns its best-effort direct-host config
    // alongside that error (`db_url.go:161-163`), and `bootstrap.go:115-118` logs
    // the error to stderr and presses on with it rather than aborting. `push.Run`
    // dials fresh on every call (`push.go:29`) and bootstrap retries `push.Run`
    // itself (`bootstrap.go:122-127`), so this leniency buys real reconnect
    // attempts across the backoff window — e.g. while a freshly created
    // project's link/pooler metadata is still propagating — not a guaranteed
    // repeat failure. Reproduced below: catch that one error tag, log it, and
    // fall back to the same direct-host shape already computed for `.env` above
    // (step K's `dbConfig`) instead of failing bootstrap outright.
    //
    // Go never re-resolves the project ref or config.toml for push (reuses what
    // step I already loaded above) — so this passes `workdir`/`projectRef`/`toml`
    // straight through as plain values instead of calling `legacyDbPush` (the
    // full flags-based command), which would re-resolve them via
    // `LegacyProjectRefResolver`/`LegacyDbConfigResolver` — both keyed off
    // `LegacyCliConfig.workdir`, stale after this handler's own `process.chdir`
    // above (step D) since that layer is built once, before the handler runs.
    //
    // `legacyBootstrapRetryNotify`/`Effect.retry(retry)` reproduce Go's
    // `policy.Reset()` + `backoff.RetryNotify` wrap around the push call
    // (`bootstrap.go:122-127`), matching the api-keys/health-poll retries above —
    // matching Go, only `push.Run` itself is retried, not the connection
    // resolution (Go's `NewDbConfigWithPassword` runs once, outside the loop).
    // No instrumentation wrap: `legacyDbPushCore` is the bare handler function,
    // not `push.command.ts`'s wrapped command, so it never fires its own
    // `cli_command_executed` — no double-count risk.
    //
    // `legacyResolveLinkedConn` (unlike `LegacyDbConfigResolver.resolve`) returns a
    // bare connection with no `suggestionContext` attached — that context is normally
    // stapled on by the resolver layer bootstrap deliberately bypasses (see this
    // call's own doc comment above). Attach it here too, so a connect failure inside
    // the native push (refused/auth/IPv6/wrong-profile) still renders Go's
    // `SetConnectSuggestion` hint instead of silently falling back to the generic
    // "--debug" suggestion.
    const suggestionContext: LegacyConnectSuggestionContext = {
      dashboardUrl: cliConfig.dashboardUrl,
      profileName: cliConfig.profile,
    };
    const resolvedConn = yield* legacyResolveLinkedConn(
      projectRef,
      workdir,
      cliConfig.projectHost,
      cliConfig.poolerHost,
      dnsResolver,
      Option.some(created.dbPassword),
      false,
    ).pipe(
      Effect.catchTag("LegacyDbConfigIpv6Error", (error) =>
        output.raw(`${error.message}\n`, "stderr").pipe(Effect.as(dbConfig)),
      ),
    );
    const conn = { ...resolvedConn, suggestionContext };
    const pushNotify = legacyBootstrapRetryNotify();
    yield* legacyDbPushCore({
      workdir,
      projectRef,
      conn,
      isLocal: false,
      repairSuggestsLocalFlag: false,
      dryRun: false,
      includeAll: false,
      includeRoles: true,
      includeSeed: true,
      includeVault: true,
      dnsResolver,
      projectId: cliConfig.projectId,
      toml,
      yes: pushYes,
      emitStructuredResult: false,
    }).pipe(pushNotify, Effect.retry(retry));

    // M. Start suggestion. `bootstrap.go:128-130`.
    if (isText) {
      const suggestion = suggestAppStart(runtimeInfo.cwd, workdir, starter.start, legacyAqua);
      yield* emitSuccessTrailer(`${suggestion}\n`);
    } else {
      yield* output.success("", {
        workdir,
        project_ref: projectRef,
        template: starter.name,
        start_command: starter.start,
        env_file: envFileWritten ? envFilePath : null,
      });
    }
    yield* setSuccessWorkingDirectory(workdir);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        try {
          process.chdir(originalCwd);
        } catch {
          /* original cwd vanished — nothing to restore to */
        }
      }),
    ),
    Effect.ensuring(
      Effect.suspend(() =>
        createdRef === undefined
          ? Effect.void
          : linkedProjectCache.cache(createdRef, resolvedWorkdir),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
    // Load-bearing: `legacyApplyProjectEnv` (step I) uses `Effect.acquireRelease`
    // to revert `SUPABASE_INTERNAL_IMAGE_REGISTRY` when its scope closes. Its
    // lifetime must span the rest of this handler (link services, health poll,
    // `.env` write, and the push step's own edge-runtime/pg-delta cache use of
    // that env var) — matching Go's process-lifetime `os.Setenv` — so the scope
    // is closed here, at the outermost pipe, not narrowly around a single step.
    Effect.scoped,
  );
});

// Whether `cause` is the generated client's `SchemaError` — a 200 response the
// client could not decode, as opposed to a transport failure (DNS, TLS,
// timeout).
function isDecodeFailureCause(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) {
    return false;
  }
  return cause._tag === "SchemaError";
}

// Mirrors Go's `checkProjectHealth` non-200 branch: `Error status %d: %s`.
const mapHealthError = (cause: unknown): Effect.Effect<never, LegacyBootstrapHealthError> => {
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const status = cause.response.status;
    return cause.response.text.pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map(sanitizeLegacyErrorBody),
      Effect.flatMap((body) =>
        Effect.fail(
          new LegacyBootstrapHealthError({ message: `Error status ${status}: ${body}`, status }),
        ),
      ),
    );
  }
  return Effect.fail(
    isDecodeFailureCause(cause)
      ? new LegacyBootstrapHealthError({ message: `Error status 0: ${cause}`, decode: true })
      : new LegacyBootstrapHealthError({ message: `Error status 0: ${cause}`, transport: true }),
  );
};
