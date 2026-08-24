// oxlint-disable effecttsgo/async-function, effecttsgo/global-console-in-effect, effecttsgo/global-date, effecttsgo/global-error-in-effect-catch, effecttsgo/global-error-in-effect-failure, effecttsgo/global-fetch-in-effect, effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json, effecttsgo/process-env -- live-project orchestration is a foreign subprocess/network test boundary.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { makeApiClient, type OperationOutput } from "@supabase/api/effect";
import { Cause, Data, Effect, Exit, Schedule } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import {
  deriveLiveProjectHost,
  keepLiveProject,
  liveApiUrl,
  liveOrgId,
  liveProjectName,
  liveRegion,
} from "./live-env.ts";

const PROJECT_REF_RE = /^[a-z]{20}$/u;
const TERMINAL_BAD_STATUSES = new Set(["INIT_FAILED", "RESTORE_FAILED", "REMOVED"]);
const PROFILE_NAME = "supabase-cli-live";
const POLL_INTERVAL = "5 seconds";
const POLL_TIMEOUT = "5 minutes";

type Project = OperationOutput<"v1GetProject">;
type Organization = OperationOutput<"v1ListAllOrganizations">[number];
type ApiKey = OperationOutput<"v1GetProjectApiKeys">[number];
export type PoolerConfig = OperationOutput<"v1GetPoolerConfig">[number];
type LiveApi = Effect.Success<ReturnType<typeof makeApiClient>>;
type Region =
  | "us-east-1"
  | "us-east-2"
  | "us-west-1"
  | "us-west-2"
  | "ap-east-1"
  | "ap-southeast-1"
  | "ap-northeast-1"
  | "ap-northeast-2"
  | "ap-southeast-2"
  | "eu-west-1"
  | "eu-west-2"
  | "eu-west-3"
  | "eu-north-1"
  | "eu-central-1"
  | "eu-central-2"
  | "ca-central-1"
  | "ap-south-1"
  | "sa-east-1";

const REGIONS: ReadonlyArray<Region> = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ap-east-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "eu-central-1",
  "eu-central-2",
  "ca-central-1",
  "ap-south-1",
  "sa-east-1",
];

class LiveTransientPoll extends Data.TaggedError("LiveTransientPoll")<{
  readonly phase: string;
  readonly cause?: unknown;
}> {}

class LiveTerminalPoll extends Data.TaggedError("LiveTerminalPoll")<{
  readonly phase: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

class LivePollTimeout extends Data.TaggedError("LivePollTimeout")<{
  readonly phase: string;
}> {
  override get message(): string {
    return `${this.phase} timed out`;
  }
}

class LiveStorageError extends Data.TaggedError("LiveStorageError")<{
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}> {}

function apiError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function supportedRegion(value: string): Effect.Effect<Region, Error> {
  const region = REGIONS.find((candidate) => candidate === value);
  return region === undefined
    ? Effect.fail(new Error(`Unsupported SUPABASE_LIVE_REGION ${JSON.stringify(value)}`))
    : Effect.succeed(region);
}

/** HTTP statuses that can occur while a newly-created project propagates. */
export function isTransientStorageStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Retry only transport failures and statuses plausibly caused by propagation. */
export function isTransientLiveError(error: unknown): boolean {
  if (!HttpClientError.isHttpClientError(error)) return false;
  if (error.reason._tag === "TransportError") return true;
  return (
    error.reason._tag === "StatusCodeError" &&
    isTransientStorageStatus(error.reason.response.status)
  );
}

export function selectPrimaryPoolerConfig(
  configs: ReadonlyArray<PoolerConfig>,
): PoolerConfig | undefined {
  return configs.find((config) => config.database_type === "PRIMARY");
}

export function resolvePoolerDatabaseUrl(
  connectionString: string,
  poolMode: PoolerConfig["pool_mode"],
  password: string,
): string {
  const url = new URL(connectionString);
  url.password = password;
  if (poolMode !== "session" && url.port === "6543") url.port = "5432";
  if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "30");
  return url.toString();
}

function classifyPollError(phase: string, cause: unknown): LiveTransientPoll | LiveTerminalPoll {
  return isTransientLiveError(cause)
    ? new LiveTransientPoll({ phase, cause })
    : new LiveTerminalPoll({
        phase,
        message: `${phase} failed: ${apiError(cause).message}`,
        cause,
      });
}

/** Retry a transient management operation using Effect's schedule and deadline semantics. */
export function retryLiveEffect<A, E>(
  phase: string,
  effect: Effect.Effect<A, E, never>,
  options: {
    readonly interval?: import("effect").Duration.Input;
    readonly timeout?: import("effect").Duration.Input;
    readonly shouldRetry?: (error: E) => boolean;
  } = {},
): Effect.Effect<A, E | LivePollTimeout, never> {
  const retrying = Effect.retry(effect, {
    schedule: Schedule.spaced(options.interval ?? POLL_INTERVAL),
    ...(options.shouldRetry === undefined ? {} : { while: options.shouldRetry }),
  });
  return Effect.timeoutOrElse(retrying, {
    duration: options.timeout ?? POLL_TIMEOUT,
    orElse: () => Effect.fail(new LivePollTimeout({ phase })),
  });
}

/** Build one diagnostic while retaining every target and cleanup failure. */
export function cleanupErrors(primary: unknown, cleanup: ReadonlyArray<unknown>): AggregateError {
  const errors = [primary, ...cleanup].map(apiError);
  return new AggregateError(errors, "Live e2e lifecycle failed");
}

function timeoutLiveRequest<A, E>(
  phase: string,
  effect: Effect.Effect<A, E, never>,
): Effect.Effect<A, E | Error, never> {
  return Effect.timeoutOrElse(effect, {
    duration: POLL_TIMEOUT,
    orElse: () => Effect.fail(new Error(`${phase} timed out`)),
  });
}

function uniqueProjectName(): string {
  const runId = process.env["GITHUB_RUN_ID"] ?? process.env["CI_JOB_ID"] ?? String(Date.now());
  return `${liveProjectName()}-${runId}-${randomUUID().slice(0, 8)}`;
}

function databasePassword(): string {
  return `supabase-cli-live-${randomBytes(12).toString("hex")}`;
}

function resolveOrganization(api: LiveApi): Effect.Effect<Organization, Error, never> {
  return timeoutLiveRequest("organization lookup", api.v1.listAllOrganizations()).pipe(
    Effect.mapError(apiError),
    Effect.flatMap((organizations) => {
      const requested = liveOrgId();
      const organization =
        requested === undefined
          ? organizations[0]
          : organizations.find(
              (candidate) => candidate.id === requested || candidate.slug === requested,
            );
      return organization === undefined
        ? Effect.fail(
            new Error(
              requested === undefined
                ? "No organizations found; cannot create the live project"
                : `Organization ${requested} was not found; cannot create the live project`,
            ),
          )
        : Effect.succeed(organization);
    }),
  );
}

function createProject(
  api: LiveApi,
  name: string,
  password: string,
): Effect.Effect<string, Error, never> {
  return supportedRegion(liveRegion()).pipe(
    Effect.flatMap((region) =>
      resolveOrganization(api).pipe(
        Effect.flatMap((organization) =>
          timeoutLiveRequest(
            "project creation",
            api.v1.createAProject({
              name,
              db_pass: password,
              organization_slug: organization.slug,
              region,
            }),
          ).pipe(Effect.mapError(apiError)),
        ),
      ),
    ),
    Effect.flatMap((project) =>
      PROJECT_REF_RE.test(project.ref)
        ? Effect.succeed(project.ref)
        : Effect.fail(new Error(`Unexpected project ref from project creation: ${project.ref}`)),
    ),
  );
}

function deleteProject(api: LiveApi, ref: string): Effect.Effect<void, Error, never> {
  return timeoutLiveRequest("project deletion", api.v1.deleteAProject({ ref })).pipe(
    Effect.mapError(apiError),
    Effect.asVoid,
  );
}

function projectReadiness(
  api: LiveApi,
  ref: string,
): Effect.Effect<Project, LiveTransientPoll | LiveTerminalPoll, never> {
  return api.v1.getProject({ ref }).pipe(
    Effect.mapError((cause) => classifyPollError("project readiness", cause)),
    Effect.flatMap(
      (project): Effect.Effect<Project, LiveTransientPoll | LiveTerminalPoll, never> => {
        if (project.status === "ACTIVE_HEALTHY") return Effect.succeed(project);
        if (TERMINAL_BAD_STATUSES.has(project.status)) {
          return Effect.fail(
            new LiveTerminalPoll({
              phase: "project readiness",
              message: `Project ${ref} entered terminal status ${project.status}`,
            }),
          );
        }
        return Effect.fail(
          new LiveTransientPoll({
            phase: "project readiness",
            cause: `status=${project.status}`,
          }),
        );
      },
    ),
  );
}

function waitForProject(api: LiveApi, ref: string): Effect.Effect<Project, Error, never> {
  return retryLiveEffect("project readiness", projectReadiness(api, ref), {
    shouldRetry: (error) => error instanceof LiveTransientPoll,
  }).pipe(
    Effect.mapError((error) => {
      if (error instanceof LiveTerminalPoll) return new Error(error.message);
      if (error instanceof LivePollTimeout) return new Error(error.message);
      return apiError(error);
    }),
  );
}

function keysReadiness(
  api: LiveApi,
  ref: string,
): Effect.Effect<
  { anonKey: string; serviceRoleKey: string },
  LiveTransientPoll | LiveTerminalPoll,
  never
> {
  return api.v1.getProjectApiKeys({ ref, reveal: true }).pipe(
    Effect.mapError((cause) => classifyPollError("project API keys", cause)),
    Effect.flatMap((keys) => {
      const keyValue = (key: ApiKey): string | undefined => key.api_key ?? undefined;
      const anonKey = keys.find((key) => key.name === "anon");
      const serviceRoleKey =
        keys.find((key) => key.name === "service_role") ??
        keys.find((key) => key.api_key?.startsWith("sb_secret_"));
      const anon = anonKey === undefined ? undefined : keyValue(anonKey);
      const service = serviceRoleKey === undefined ? undefined : keyValue(serviceRoleKey);
      return anon === undefined || service === undefined
        ? Effect.fail(
            new LiveTransientPoll({ phase: "project API keys", cause: "keys incomplete" }),
          )
        : Effect.succeed({ anonKey: anon, serviceRoleKey: service });
    }),
  );
}

function resolveKeys(
  api: LiveApi,
  ref: string,
): Effect.Effect<{ anonKey: string; serviceRoleKey: string }, Error, never> {
  return retryLiveEffect("project API keys", keysReadiness(api, ref), {
    shouldRetry: (error) => error instanceof LiveTransientPoll,
  }).pipe(
    Effect.mapError((error) =>
      error instanceof LivePollTimeout
        ? new Error(`Project ${ref} did not return API keys within ${POLL_TIMEOUT}`)
        : error instanceof LiveTerminalPoll
          ? new Error(error.message)
          : apiError(error),
    ),
  );
}

function dbReadiness(
  api: LiveApi,
  ref: string,
  password: string,
): Effect.Effect<string, LiveTransientPoll | LiveTerminalPoll, never> {
  return api.v1.getPoolerConfig({ ref }).pipe(
    Effect.mapError((cause): LiveTransientPoll | LiveTerminalPoll =>
      classifyPollError("pooler configuration", cause),
    ),
    Effect.flatMap(
      (configs): Effect.Effect<string, LiveTransientPoll | LiveTerminalPoll, never> => {
        const primary = selectPrimaryPoolerConfig(configs);
        if (primary === undefined || primary.connection_string.trim().length === 0) {
          return Effect.fail(
            new LiveTransientPoll({
              phase: "pooler configuration",
              cause:
                primary === undefined
                  ? "primary pooler config missing"
                  : "connection string missing",
            }),
          );
        }
        try {
          return Effect.succeed(
            resolvePoolerDatabaseUrl(primary.connection_string, primary.pool_mode, password),
          );
        } catch (cause) {
          return Effect.fail(
            new LiveTerminalPoll({
              phase: "pooler configuration",
              message: `pooler configuration returned an invalid connection string: ${apiError(cause).message}`,
              cause,
            }),
          );
        }
      },
    ),
  );
}

function resolveDbUrl(
  api: LiveApi,
  ref: string,
  password: string,
): Effect.Effect<string, Error, never> {
  return retryLiveEffect("pooler configuration", dbReadiness(api, ref, password), {
    shouldRetry: (error) => error instanceof LiveTransientPoll,
  }).pipe(
    Effect.mapError((error) =>
      error instanceof LivePollTimeout
        ? new Error(
            `Project ${ref} did not return a pooler connection string within ${POLL_TIMEOUT}`,
          )
        : error instanceof LiveTerminalPoll
          ? new Error(error.message)
          : apiError(error),
    ),
  );
}

function createStorageBucket(
  ref: string,
  host: string,
  serviceRoleKey: string,
  bucket: string,
): Effect.Effect<void, Error, never> {
  const attempt = Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`https://${ref}.${host}/storage/v1/bucket`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: bucket, name: bucket, public: false }),
        signal,
      });
      if (!response.ok && response.status !== 409) {
        throw new LiveStorageError({
          message: `Failed to create storage bucket ${bucket}: ${response.status} ${await response.text()}`,
          retryable: isTransientStorageStatus(response.status),
        });
      }
    },
    catch: (cause) =>
      cause instanceof LiveStorageError
        ? cause
        : new LiveStorageError({
            message: `Failed to create storage bucket ${bucket}: ${apiError(cause).message}`,
            retryable: true,
            cause,
          }),
  });
  return retryLiveEffect("storage bucket", attempt, {
    shouldRetry: (error) => error instanceof LiveStorageError && error.retryable,
  }).pipe(
    Effect.mapError((error) =>
      error instanceof LivePollTimeout
        ? new Error(`storage bucket ${bucket} creation timed out`)
        : error instanceof LiveStorageError
          ? new Error(error.message)
          : apiError(error),
    ),
  );
}

function writeProfile(
  projectRef: string,
  projectHost: string,
  dbUrl: string,
): Effect.Effect<string, Error, never> {
  return Effect.tryPromise({
    try: async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "supabase-live-profile-"));
      const profilePath = path.join(directory, "profile.yaml");
      try {
        const poolerHost = new URL(dbUrl).hostname;
        await writeFile(
          profilePath,
          [
            `name: ${PROFILE_NAME}`,
            `api_url: ${JSON.stringify(liveApiUrl())}`,
            `dashboard_url: ${JSON.stringify(liveApiUrl())}`,
            `project_host: ${projectHost}`,
            `pooler_host: ${poolerHost}`,
            `# provisioned project: ${projectRef}`,
            "",
          ].join("\n"),
        );
        return profilePath;
      } catch (cause) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (cleanup) {
          throw cleanupErrors(cause, [cleanup]);
        }
        throw cause;
      }
    },
    catch: apiError,
  });
}

function cleanupDirectory(profilePath: string): Effect.Effect<void, Error, never> {
  return Effect.tryPromise({
    try: () => rm(path.dirname(profilePath), { recursive: true, force: true }),
    catch: apiError,
  });
}

function cleanupRemote(
  api: LiveApi,
  environment: LiveProjectEnvironment,
): Effect.Effect<void, Error, never> {
  return keepLiveProject()
    ? Effect.sync(() => {
        console.log(`SUPABASE_LIVE_KEEP_PROJECT=1 — leaving ${environment.project.ref} alive`);
      })
    : deleteProject(api, environment.project.ref);
}

function cleanupCreatedProject(api: LiveApi, ref: string): Effect.Effect<void, Error, never> {
  return keepLiveProject()
    ? Effect.sync(() => {
        console.log(
          `SUPABASE_LIVE_KEEP_PROJECT=1 — leaving ${ref} alive after provisioning failure`,
        );
      })
    : deleteProject(api, ref);
}

function combineCleanupExits(
  exits: ReadonlyArray<Exit.Exit<void, unknown>>,
): Effect.Effect<void, Error, never> {
  const errors = exits.flatMap((exit) => (Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : []));
  return errors.length === 0
    ? Effect.void
    : Effect.fail(new AggregateError(errors, "Live cleanup failed"));
}

export interface LiveProjectEnvironment {
  readonly project: {
    readonly ref: string;
    readonly dbUrl: string;
    readonly dbPassword: string;
    readonly anonKey: string;
    readonly serviceRoleKey: string;
    readonly functionsUrl: string;
    readonly storageBucket: string;
  };
  readonly profilePath: string;
}

/** Provision one project; the caller owns the outer Effect runtime boundary. */
export function provisionLiveEnvironment(
  api: LiveApi,
): Effect.Effect<LiveProjectEnvironment, Error, never> {
  return Effect.gen(function* () {
    const password = databasePassword();
    const ref = yield* createProject(api, uniqueProjectName(), password);
    const setup = Effect.gen(function* () {
      const project = yield* waitForProject(api, ref);
      const projectHost = deriveLiveProjectHost(project.database.host, ref);
      const keys = yield* resolveKeys(api, ref);
      const dbUrl = yield* resolveDbUrl(api, ref, password);
      const storageBucket = "supabase-cli-live-bucket";
      yield* createStorageBucket(ref, projectHost, keys.serviceRoleKey, storageBucket);
      const profilePath = yield* writeProfile(ref, projectHost, dbUrl);
      return {
        project: {
          ref,
          dbUrl,
          dbPassword: password,
          anonKey: keys.anonKey,
          serviceRoleKey: keys.serviceRoleKey,
          functionsUrl: `https://${ref}.${projectHost}/functions/v1`,
          storageBucket,
        },
        profilePath,
      } satisfies LiveProjectEnvironment;
    });
    const setupExit = yield* Effect.exit(setup);
    if (Exit.isSuccess(setupExit)) return setupExit.value;

    const cleanupExit = yield* Effect.exit(cleanupCreatedProject(api, ref));
    if (Exit.isSuccess(cleanupExit)) return yield* Effect.failCause(setupExit.cause);
    return yield* Effect.fail(
      cleanupErrors(Cause.squash(setupExit.cause), [Cause.squash(cleanupExit.cause)]),
    );
  });
}

/** Delete the exact owned project and always remove its temporary profile. */
export function cleanupLiveEnvironment(
  api: LiveApi,
  environment: LiveProjectEnvironment,
): Effect.Effect<void, Error, never> {
  return Effect.gen(function* () {
    const [profileExit, projectExit] = yield* Effect.all(
      [
        Effect.exit(cleanupDirectory(environment.profilePath)),
        Effect.exit(cleanupRemote(api, environment)),
      ],
      { concurrency: "unbounded" },
    );
    yield* combineCleanupExits([profileExit, projectExit]);
  });
}
