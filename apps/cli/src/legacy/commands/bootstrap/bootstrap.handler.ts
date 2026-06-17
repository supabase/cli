import { Effect, FileSystem, Option, Path, Schedule } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { LegacyPlatformApi } from "../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyWorkdirFlag, LegacyYesFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { legacyAqua, legacyBold } from "../../shared/legacy-colors.ts";
import { legacyEnsureLogin } from "../../shared/legacy-ensure-login.ts";
import { legacyGetProjectApiKeys } from "../../shared/legacy-get-api-keys.ts";
import { sanitizeLegacyErrorBody } from "../../shared/legacy-http-errors.ts";
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
  const proxy = yield* LegacyGoProxy;
  const api = yield* LegacyPlatformApi;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const workdirFlag = yield* LegacyWorkdirFlag;
  const yesFlag = yield* LegacyYesFlag;

  const isText = output.format === "text";
  const retry = { schedule: retrySchedule, times: LEGACY_BOOTSTRAP_MAX_RETRIES } as const;

  // `process.chdir` mirrors Go's `ChangeWorkDir`; restore the original cwd in a
  // finalizer so the (mocked) proxy step still inherits the bootstrap workdir
  // while leaving the surrounding process untouched.
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
      const overwrite = yesFlag
        ? true
        : yield* output.promptConfirm(
            `Do you want to overwrite existing files in ${legacyBold(workdir)} directory?`,
            { defaultValue: true },
          );
      if (!overwrite) {
        return yield* new LegacyBootstrapOverwriteDeclinedError({ message: "context canceled" });
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

    // I. Link services (best-effort, anon key) + mandatory project-ref write.
    // `bootstrap.go:98-105`. Go calls `link.LinkServices` (no telemetry / status).
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

    // K. Derive db config + write .env (non-fatal). `bootstrap.go:114-121`.
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

    // L. Push migrations — DELEGATED to the Go binary (interim; see SIDE_EFFECTS.md).
    // No instrumentation wrap: the subprocess fires its own push telemetry.
    // `bootstrap.go:122-127` -> push.Run(..., includeRoles, includeSeed) =>
    // `--include-roles --include-seed` (no `--include-all`).
    //
    // Channel parity (CLI-1617): the proxy must be called 1:1 with the user's
    // input — a flag stays a flag, an env var stays an env var. Go binds
    // bootstrap's `-p` to viper `DB_PASSWORD` and `db push` reads it from viper
    // (== the `SUPABASE_DB_PASSWORD` env var for the subprocess), so only a
    // flag-sourced password travels as `--password`; an env-/prompt-sourced one
    // travels as the env var.
    //
    // The flag branch keys on a *non-empty* flag value: an explicit `--password ""`
    // (e.g. an unset `$SUPABASE_DB_PASSWORD` expanded by the shell) leaves viper
    // `DB_PASSWORD` empty in Go too, so `create.promptMissingParams` prompts and
    // `viper.Set`s the resolved value — which in-process `db push` then reads.
    // Forwarding the literal empty flag would lose that prompted password, so an
    // empty flag falls through to the resolved `created.dbPassword` (which carries
    // the env- or prompt-sourced value) on the env channel.
    const pushArgs = ["db", "push", "--include-roles", "--include-seed"];
    if (Option.isSome(flags.password) && flags.password.value.length > 0) {
      pushArgs.push("--password", flags.password.value);
      yield* proxy.exec(pushArgs);
    } else {
      yield* proxy.exec(
        pushArgs,
        created.dbPassword.length > 0
          ? { env: { SUPABASE_DB_PASSWORD: created.dbPassword } }
          : undefined,
      );
    }

    // M. Start suggestion. `bootstrap.go:128-130`.
    if (isText) {
      const suggestion = suggestAppStart(runtimeInfo.cwd, workdir, starter.start, legacyAqua);
      yield* output.raw(`${suggestion}\n`, "stderr");
    } else {
      yield* output.success("", {
        workdir,
        project_ref: projectRef,
        template: starter.name,
        start_command: starter.start,
        env_file: envFileWritten ? envFilePath : null,
      });
    }
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
  );
});

// Mirrors Go's `checkProjectHealth` non-200 branch: `Error status %d: %s`.
const mapHealthError = (cause: unknown): Effect.Effect<never, LegacyBootstrapHealthError> => {
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const status = cause.response.status;
    return cause.response.text.pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map(sanitizeLegacyErrorBody),
      Effect.flatMap((body) =>
        Effect.fail(new LegacyBootstrapHealthError({ message: `Error status ${status}: ${body}` })),
      ),
    );
  }
  return Effect.fail(new LegacyBootstrapHealthError({ message: `Error status 0: ${cause}` }));
};
