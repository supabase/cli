import { Effect, FileSystem, Option, Path, Schedule } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import {
  DnsResolverFlag,
  WorkdirFlag,
  resolveYes,
  resolveYesWithProjectEnv,
} from "../../command-internal/global-flags.ts";
import {
  emitSuccessTrailer,
  setSuccessWorkingDirectory,
} from "../../shared/cli/success-trailer.ts";
import { promptYesNo } from "../../command-internal/prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../shared/output/errors.ts";
import { Output } from "../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { aqua, bold } from "../../command-internal/colors.ts";
import { ensureLogin } from "../../command-internal/ensure-login.ts";
import { getProjectApiKeys } from "../../command-internal/get-api-keys.ts";
import { sanitizeErrorBody } from "../../command-internal/http-errors.ts";
import type { ConnectSuggestionContext } from "../../command-internal/connect-errors.ts";
import { resolveLinkedConn } from "../../command-internal/db-config.layer.ts";
import {
  applyProjectEnv,
  checkDbToml,
  loadProjectEnv,
} from "../../command-internal/db-config.toml-read.ts";
import { dbPushCore } from "../../command-internal/db-push-core.ts";
import { linkServicesCore } from "../../command-internal/link-services-core.ts";
import { projectCreateCore } from "../../command-internal/project-create-core.ts";
import { tempPaths } from "../../command-internal/temp-paths.ts";
import { extractServiceKeys } from "../../command-internal/tenant-keys.ts";
import { parseDotEnv } from "../../command-internal/dotenv.ts";
import { initProject } from "../../shared/init/project-init.ts";
import { buildDotEnv, marshalDotEnv } from "./bootstrap.dotenv.ts";
import {
  BootstrapHealthError,
  BootstrapInvalidTemplateError,
  BootstrapOverwriteDeclinedError,
  BootstrapWorkdirReadError,
} from "./bootstrap.errors.ts";
import { deriveDbConfig } from "./bootstrap.pgconfig.ts";
import { suggestAppStart } from "./bootstrap.suggest.ts";
import {
  BOOTSTRAP_MAX_RETRIES,
  bootstrapBackoff,
  bootstrapRetryNotify,
} from "./bootstrap.retry.ts";
import { type StarterTemplate, TemplateService } from "./bootstrap.templates.ts";
import type { BootstrapFlags } from "./bootstrap.command.ts";

const SCRATCH_TEMPLATE: StarterTemplate = {
  name: "scratch",
  description: "An empty project from scratch.",
  url: "",
  start: "supabase start",
};

export const bootstrap = Effect.fn("bootstrap")(function* (
  flags: BootstrapFlags,
  retrySchedule: Schedule.Schedule<unknown> = bootstrapBackoff,
) {
  const output = yield* Output;
  const tty = yield* Tty;
  const runtimeInfo = yield* RuntimeInfo;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const templateService = yield* TemplateService;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const workdirFlag = yield* WorkdirFlag;
  const dnsResolver = yield* DnsResolverFlag;
  const yesFlag = yield* resolveYes;

  const isText = output.format === "text";
  const retry = { schedule: retrySchedule, times: BOOTSTRAP_MAX_RETRIES } as const;

  // Restores the original cwd once bootstrap returns, since `process.chdir` below is a global
  // process mutation; every step reads its own `workdir` var, never `process.cwd()`, so nothing
  // else depends on the chdir staying in effect.
  const originalCwd = process.cwd();
  let createdRef: string | undefined;
  // Hoisted so the linked-project-cache finalizer writes beside the other `supabase/.temp/`
  // files instead of `cliSettings.workdir`.
  let resolvedWorkdir: string | undefined;

  yield* Effect.gen(function* () {
    // Reads the prefixed `SUPABASE_WORKDIR` only (never plain `WORKDIR`).
    const workdirRaw = Option.isSome(workdirFlag)
      ? workdirFlag.value
      : process.env["SUPABASE_WORKDIR"];
    const workdirInput =
      workdirRaw ??
      (yield* output.promptText(
        `Enter a directory to bootstrap your project (or leave blank to use ${bold(
          runtimeInfo.cwd,
        )}): `,
      ));
    const workdir = path.isAbsolute(workdirInput)
      ? workdirInput
      : path.join(runtimeInfo.cwd, workdirInput);
    resolvedWorkdir = workdir;

    const samples = yield* templateService.listSamples;
    const allTemplates = [...samples, SCRATCH_TEMPLATE];
    let starter: StarterTemplate;
    if (Option.isSome(flags.template)) {
      const name = flags.template.value;
      const match = allTemplates.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (match === undefined) {
        return yield* new BootstrapInvalidTemplateError({
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

    yield* fs.makeDirectory(workdir, { recursive: true });
    const entries = yield* fs
      .readDirectory(workdir)
      .pipe(
        Effect.mapError(
          (cause) => new BootstrapWorkdirReadError({ message: `failed to read workdir: ${cause}` }),
        ),
      );
    if (entries.length > 0) {
      // `--yes`/`SUPABASE_YES` auto-confirms with a `<title> [Y/n] y` stderr echo; non-TTY
      // stdin scans one piped line (100ms) before falling back to Yes.
      const overwrite = yield* promptYesNo(
        output,
        yesFlag,
        `Do you want to overwrite existing files in ${bold(workdir)} directory?`,
        true,
      );
      if (!overwrite) {
        return yield* new BootstrapOverwriteDeclinedError({
          message: CONTEXT_CANCELED_MESSAGE,
        });
      }
    }

    yield* Effect.sync(() => process.chdir(workdir));
    if (workdir !== runtimeInfo.cwd) {
      yield* output.raw(`Using workdir ${bold(workdir)}\n`, "stderr");
    }

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

    yield* ensureLogin({ openBrowser: tty.stdinIsTty });

    const seededPassword = Option.isSome(flags.password)
      ? flags.password.value
      : (process.env["SUPABASE_DB_PASSWORD"] ?? "");
    const created = yield* projectCreateCore({
      name: path.basename(workdir),
      orgId: "",
      dbPassword: seededPassword,
      region: undefined,
      size: undefined,
      highAvailability: undefined,
      releaseChannel: undefined,
      postgresEngine: undefined,
      templateUrl: starter.url.length > 0 ? starter.url : undefined,
      emitStructuredResult: false,
    });
    const projectRef = created.ref;
    createdRef = projectRef.length > 0 ? projectRef : undefined;

    // A fresh notifier per retry block keeps this step's "Retry (n/8)" counter independent of
    // the health-poll and push retries below.
    const apiKeysNotify = bootstrapRetryNotify();
    const keys = yield* Effect.gen(function* () {
      if (isText) yield* output.raw("Linking project...\n", "stderr");
      return yield* getProjectApiKeys(projectRef);
    }).pipe(apiKeysNotify, Effect.retry(retry));
    const { anon } = extractServiceKeys(keys);

    // Config load must run before link/health/`.env` steps: a malformed config.toml aborts here
    // rather than after side effects start. `applyProjectEnv`'s scope stays open for the rest of
    // this handler (closed by the outer `Effect.scoped` below).
    const projectEnv = yield* loadProjectEnv(fs, path, workdir);
    yield* applyProjectEnv(projectEnv);
    const pushYes = yield* resolveYesWithProjectEnv(projectEnv);
    const toml = yield* checkDbToml(fs, path, workdir, projectRef);
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }

    yield* linkServicesCore({
      ref: projectRef,
      serviceKey: anon,
      skipPooler: false,
      workdir,
    });
    const paths = tempPaths(path, workdir);
    yield* fs.makeDirectory(path.dirname(paths.projectRef), { recursive: true });
    yield* fs.writeFileString(paths.projectRef, projectRef);

    const healthNotify = bootstrapRetryNotify();
    yield* Effect.gen(function* () {
      if (isText) yield* output.raw("Checking project health...\n", "stderr");
      const services = yield* api.v1
        .getServicesHealth({ ref: projectRef, services: ["db"] })
        .pipe(Effect.catch(mapHealthError));
      for (const service of services) {
        if (!service.healthy) {
          return yield* new BootstrapHealthError({
            message: `Service not healthy: ${service.name} (${service.status})`,
          });
        }
      }
    }).pipe(healthNotify, Effect.retry(retry));

    // Uses a naive direct-host db config with no IPv6/pooler fallback, since `.env` is written
    // for reference only and, unlike the push connection below, is never used to actually connect.
    const dbConfig = deriveDbConfig(projectRef, created.dbPassword, cliSettings.projectHost);
    const supabaseUrl = `https://${projectRef}.${cliSettings.projectHost}`;
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

    // `resolveLinkedConn` doesn't attach a suggestionContext like the full resolver does; build
    // one manually so a connect failure inside the push below still gets the established hint.
    const suggestionContext: ConnectSuggestionContext = {
      dashboardUrl: cliSettings.dashboardUrl,
      profileName: cliSettings.profile,
    };
    // Falls back to the naive `dbConfig` on `DbConfigIpv6Error` instead of aborting, since a
    // freshly created project's pooler metadata may still be propagating.
    const resolvedConn = yield* resolveLinkedConn(
      projectRef,
      workdir,
      cliSettings.projectHost,
      cliSettings.poolerHost,
      dnsResolver,
      Option.some(created.dbPassword),
    ).pipe(
      Effect.catchTag("DbConfigIpv6Error", (error) =>
        output.raw(`${error.message}\n`, "stderr").pipe(Effect.as(dbConfig)),
      ),
    );
    const conn = { ...resolvedConn, suggestionContext };
    // Passes workdir/projectRef/toml through directly rather than calling the full `dbPush`
    // command, since its CommandSettings-based resolvers would be stale after this handler's
    // own chdir above.
    const pushNotify = bootstrapRetryNotify();
    yield* dbPushCore({
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
      toml,
      yes: pushYes,
      emitStructuredResult: false,
    }).pipe(pushNotify, Effect.retry(retry));

    if (isText) {
      const suggestion = suggestAppStart(runtimeInfo.cwd, workdir, starter.start, aqua);
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
    // `applyProjectEnv` above uses `Effect.acquireRelease` to revert
    // `SUPABASE_INTERNAL_IMAGE_REGISTRY` when its scope closes; that scope must span the rest of
    // this handler (link services, health poll, `.env` write, and the push step's own use of
    // that var), so it's closed here rather than narrowly around a single step.
    Effect.scoped,
  );
});

// True when `cause` is the generated client's undecodable `SchemaError`, not a transport failure.
function isDecodeFailureCause(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) {
    return false;
  }
  return cause._tag === "SchemaError";
}

// Non-200 branch: `Error status <status>: <body>`.
const mapHealthError = (cause: unknown): Effect.Effect<never, BootstrapHealthError> => {
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const status = cause.response.status;
    return cause.response.text.pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map(sanitizeErrorBody),
      Effect.flatMap((body) =>
        Effect.fail(
          new BootstrapHealthError({ message: `Error status ${status}: ${body}`, status }),
        ),
      ),
    );
  }
  return Effect.fail(
    isDecodeFailureCause(cause)
      ? new BootstrapHealthError({ message: `Error status 0: ${cause}`, decode: true })
      : new BootstrapHealthError({ message: `Error status 0: ${cause}`, transport: true }),
  );
};
