import { randomBytes } from "node:crypto";
import {
  Clock,
  Config,
  Console,
  Data,
  Effect,
  Formatter,
  Option,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { createHarness, exec } from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, REGION } from "../src/tests/env.ts";

// Shared staging-project helpers used by record setup (tests/setup.ts).
// `apiUrl` is the replay server URL, which proxies calls to staging while
// recording. The harness target + token come from env.

function harness(apiUrl: string) {
  return createHarness({ apiUrl, accessToken: ACCESS_TOKEN });
}

/** A record-setup step against the staging project failed. */
export class StagingProjectError extends Data.Error<{ readonly message: string }> {}

/** The CLI subprocess for a record-setup step could not be spawned or awaited. */
class StagingCliError extends Data.TaggedError("StagingCliError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const runCli = (apiUrl: string, args: string[]) =>
  Effect.tryPromise({
    try: () => exec(harness(apiUrl), args),
    catch: (cause) =>
      new StagingCliError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const PROJECT_REF_RE = /^[a-z]{20}$/;
const TERMINAL_BAD_STATUSES = new Set(["INIT_FAILED", "RESTORE_FAILED", "REMOVED"]);
const ProjectStatus = Schema.Struct({ status: Schema.optionalKey(Schema.String) });
const Orgs = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String })));
const CreatedProject = Schema.fromJsonString(
  Schema.Struct({ id: Schema.optionalKey(Schema.String), ref: Schema.optionalKey(Schema.String) }),
);
const ListedProjects = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      ref: Schema.optionalKey(Schema.String),
      name: Schema.String,
    }),
  ),
);

/* Schema's JSON errors drop the parser detail, so the failure keeps a bounded stdout excerpt. */
const decodeStdout = <A>(schema: Schema.Codec<A, string>, stdout: string) =>
  Schema.decodeEffect(schema)(stdout).pipe(
    Effect.mapError(
      (error) =>
        new StagingProjectError({
          message: `${error.message}\n  stdout: ${Formatter.format(stdout.slice(0, 200))}`,
        }),
    ),
  );

/** A DB password for a throwaway recording project. Randomised per call
 *  (overridable via CLI_E2E_DB_PASSWORD) so no static credential is committed —
 *  the project is deleted on teardown anyway. */
export const generateDbPassword = Effect.gen(function* () {
  const override = Option.getOrUndefined(
    yield* Config.option(Config.String("CLI_E2E_DB_PASSWORD")),
  );
  return override ?? `cli-e2e-${randomBytes(12).toString("hex")}`;
});

export const resolveOrgId = Effect.fn("StagingProject.resolveOrgId")(function* (apiUrl: string) {
  const result = yield* runCli(apiUrl, ["orgs", "list", "--output", "json"]);
  if (result.exitCode !== 0) {
    return yield* new StagingProjectError({ message: `orgs list failed: ${result.stderr}` });
  }
  const first = (yield* decodeStdout(Orgs, result.stdout))[0]?.id;
  if (!first) {
    return yield* new StagingProjectError({
      message: "No orgs found — cannot create test project",
    });
  }
  return first;
});

export const createTestProject = Effect.fn("StagingProject.createTestProject")(function* (
  apiUrl: string,
  orgId: string,
  name: string,
  password: string,
) {
  const result = yield* runCli(apiUrl, [
    "projects",
    "create",
    name,
    "--org-id",
    orgId,
    "--db-password",
    password,
    "--region",
    REGION,
    "--output",
    "json",
  ]);
  if (result.exitCode !== 0) {
    return yield* new StagingProjectError({ message: `projects create failed: ${result.stderr}` });
  }
  const project = yield* decodeStdout(CreatedProject, result.stdout);
  const ref = project.ref ?? project.id;
  if (!ref || !PROJECT_REF_RE.test(ref)) {
    return yield* new StagingProjectError({
      message: `Unexpected project ref from create: ${result.stdout}`,
    });
  }
  return ref;
});

// `throwOnError` surfaces deletion failures when a caller needs to fail loudly;
// record setup keeps the lenient default.
export const deleteTestProject = Effect.fn("StagingProject.deleteTestProject")(function* (
  apiUrl: string,
  projectRef: string,
  opts: { throwOnError?: boolean } = {},
) {
  yield* Effect.gen(function* () {
    const result = yield* runCli(apiUrl, ["projects", "delete", projectRef, "--yes"]);
    if (result.exitCode !== 0) {
      return yield* new StagingProjectError({
        message: `projects delete exited ${result.exitCode}: ${result.stderr}`,
      });
    }
  }).pipe(
    Effect.catch((err) =>
      opts.throwOnError
        ? Effect.fail(err)
        : Console.error(
            `Warning: failed to delete test project ${projectRef}:`,
            /* A Data.Error logs as a bare { message } object; log it as an Error. */
            Predicate.isTagged(err, "StagingCliError") ? err.cause : new Error(err.message),
          ),
    ),
  );
});

export const cleanupProjectsByName = Effect.fn("StagingProject.cleanupProjectsByName")(function* (
  apiUrl: string,
  names: string[],
) {
  const listResult = yield* runCli(apiUrl, ["projects", "list", "--output", "json"]);
  if (listResult.exitCode !== 0) return;

  const projects = yield* decodeStdout(ListedProjects, listResult.stdout);

  for (const project of projects.filter((p) => names.includes(p.name))) {
    const ref = project.ref ?? project.id;
    if (ref && PROJECT_REF_RE.test(ref)) {
      yield* runCli(apiUrl, ["projects", "delete", ref, "--yes"]);
    }
  }
});

/** Poll the Management API until the recording project is ACTIVE_HEALTHY. */
export const waitForProjectReady = Effect.fn("StagingProject.waitForProjectReady")(function* (
  apiBaseUrl: string,
  projectRef: string,
  timeoutMs = 300_000,
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  const poll = Effect.gen(function* () {
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      return yield* new StagingProjectError({
        message: `Project ${projectRef} did not become ACTIVE_HEALTHY within ${timeoutMs}ms`,
      });
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const res = yield* client.get(`${apiBaseUrl}/v1/projects/${projectRef}`, {
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        });
        /* A failed poll's body is cancelled when this scope closes. */
        if (res.status < 200 || res.status >= 300) return false;
        const project = yield* HttpClientResponse.schemaBodyJson(ProjectStatus)(res);
        if (project.status === "ACTIVE_HEALTHY") return true;
        if (project.status && TERMINAL_BAD_STATUSES.has(project.status)) {
          return yield* new StagingProjectError({
            message: `Project ${projectRef} entered terminal status ${project.status} during provisioning`,
          });
        }
        return false;
      }),
    );
  });
  yield* poll.pipe(
    Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: (ready) => ready }),
  );
});
