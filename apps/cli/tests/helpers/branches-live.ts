import { Data, Duration, Effect, Schedule, Schema } from "effect";

import type { LiveProject } from "./live.ts";

type BranchCliOptions = { readonly exitTimeoutMs?: number };
type BranchCliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** The Effect edge used by branch lifecycle helpers. */
export type BranchCli<E = Error> = (
  args: string[],
  options?: BranchCliOptions,
) => Effect.Effect<BranchCliResult, E, never>;

const COMMAND_TIMEOUT = 20_000;
const POLL_INTERVAL = "2 seconds";
const READINESS_TIMEOUT = Duration.seconds(60);
const REMOVAL_TIMEOUT = Duration.seconds(120);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const BranchListItem = Schema.Struct({
  name: Schema.String,
  project_ref: Schema.String,
  is_default: Schema.Boolean,
});
const BranchList = Schema.Array(BranchListItem);

class BranchCommandFailed extends Data.TaggedError("BranchCommandFailed")<{
  readonly phase: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message(): string {
    return `${this.phase} failed (exit ${this.exitCode})${this.stderr.length === 0 ? "" : `\nstderr:\n${this.stderr}`}`;
  }
}

class BranchNotReady extends Data.TaggedError("BranchNotReady")<{
  readonly phase: string;
}> {
  override get message(): string {
    return `${this.phase} is not ready`;
  }
}

class BranchPollTimedOut extends Data.TaggedError("BranchPollTimedOut")<{
  readonly phase: string;
}> {
  override get message(): string {
    return `${this.phase} timed out`;
  }
}

class BranchPayloadInvalid extends Data.TaggedError("BranchPayloadInvalid")<{
  readonly phase: string;
}> {
  override get message(): string {
    return `${this.phase} returned an unexpected payload`;
  }
}

type BranchError<E> =
  | E
  | BranchCommandFailed
  | BranchNotReady
  | BranchPollTimedOut
  | BranchPayloadInvalid
  | AggregateError;

function boundedStderr(stderr: string): string {
  return stderr.length <= 2_000 ? stderr : stderr.slice(stderr.length - 2_000);
}

function command<E>(
  cli: BranchCli<E>,
  args: string[],
  phase: string,
  timeout?: number,
): Effect.Effect<BranchCliResult, BranchError<E>, never> {
  const response = timeout === undefined ? cli(args) : cli(args, { exitTimeoutMs: timeout });
  return response.pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new BranchCommandFailed({
              phase,
              exitCode: result.exitCode,
              stderr: boundedStderr(result.stderr),
            }),
          ),
    ),
  );
}

function poll<A, E>(
  phase: string,
  effect: Effect.Effect<A, BranchError<E>, never>,
  timeout: Duration.Duration,
): Effect.Effect<A, BranchError<E>, never> {
  return Effect.timeoutOrElse(
    Effect.retry(effect, {
      schedule: Schedule.spaced(POLL_INTERVAL),
      while: (error) => error instanceof BranchNotReady,
    }),
    {
      duration: timeout,
      orElse: () => Effect.fail(new BranchPollTimedOut({ phase })),
    },
  );
}

function isNotFound(result: BranchCliResult): boolean {
  return /\b(?:status|http(?: status)?|code)\D{0,12}404\b/iu.test(result.stderr);
}

function branchRefFromCreate(
  result: BranchCliResult,
): Effect.Effect<string, BranchPayloadInvalid, never> {
  return Schema.decodeEffect(UnknownFromJsonString)(result.stdout).pipe(
    Effect.mapError(() => new BranchPayloadInvalid({ phase: "branches create" })),
    Effect.flatMap((body) =>
      typeof body === "object" &&
      body !== null &&
      "project_ref" in body &&
      typeof body.project_ref === "string" &&
      body.project_ref.length > 0
        ? Effect.succeed(body.project_ref)
        : Effect.fail(new BranchPayloadInvalid({ phase: "branches create" })),
    ),
  );
}

/** Creates one named branch and captures its immutable reference before polling readiness. */
export function createLiveBranchEffect<E>(
  cli: BranchCli<E>,
  project: LiveProject,
  name: string,
): Effect.Effect<string, BranchError<E>, never> {
  const created = command(
    cli,
    ["branches", "create", name, "--project-ref", project.ref, "--output-format", "json"],
    "branches create",
    undefined,
  );
  return created.pipe(
    Effect.flatMap((result) => branchRefFromCreate(result)),
    Effect.catch((primary) =>
      removeLiveBranchByNameEffect(cli, project, name).pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.fail(primary),
          onFailure: (cleanup) =>
            Effect.fail(new AggregateError([primary, cleanup], "Branch create and cleanup failed")),
        }),
      ),
    ),
  );
}

function getBranchReady<E>(
  cli: BranchCli<E>,
  project: LiveProject,
  name: string,
): Effect.Effect<true, BranchError<E>, never> {
  const response: Effect.Effect<BranchCliResult, E, never> = cli(
    ["branches", "get", name, "--project-ref", project.ref],
    {
      exitTimeoutMs: COMMAND_TIMEOUT,
    },
  );
  return response.pipe(
    Effect.flatMap((result): Effect.Effect<true, BranchError<E>, never> => {
      if (result.exitCode === 0) return Effect.succeed(true as const);
      if (isNotFound(result))
        return Effect.fail(new BranchNotReady({ phase: `branches get ${name}` }));
      return Effect.fail(
        new BranchCommandFailed({
          phase: `branches get ${name}`,
          exitCode: result.exitCode,
          stderr: boundedStderr(result.stderr),
        }),
      );
    }),
  );
}

/** Waits until name lookup observes a created or renamed branch. */
export function awaitLiveBranchEffect<E>(
  cli: BranchCli<E>,
  project: LiveProject,
  name: string,
): Effect.Effect<true, BranchError<E>, never> {
  return poll(
    `branches get ${name}`,
    Effect.suspend(() => getBranchReady(cli, project, name)),
    READINESS_TIMEOUT,
  );
}

function listBranches<E>(
  cli: BranchCli<E>,
  project: LiveProject,
  phase: string,
): Effect.Effect<ReadonlyArray<Schema.Schema.Type<typeof BranchListItem>>, BranchError<E>, never> {
  return command(
    cli,
    ["branches", "list", "--output", "json", "--project-ref", project.ref],
    phase,
    COMMAND_TIMEOUT,
  ).pipe(
    Effect.flatMap((result) =>
      Schema.decodeEffect(Schema.fromJsonString(BranchList))(result.stdout).pipe(
        Effect.mapError(() => new BranchPayloadInvalid({ phase })),
      ),
    ),
  );
}

/** Waits until the list endpoint contains the named branch. */
export function awaitLiveBranchListedEffect<E>(
  cli: BranchCli<E>,
  project: LiveProject,
  name: string,
): Effect.Effect<true, BranchError<E>, never> {
  const read = listBranches(cli, project, `branches list ${name}`).pipe(
    Effect.flatMap((branches) =>
      branches.some((branch) => branch["name"] === name)
        ? Effect.succeed(true as const)
        : Effect.fail(new BranchNotReady({ phase: `branches list ${name}` })),
    ),
  );
  return poll(
    `branches list ${name}`,
    Effect.suspend(() => read),
    READINESS_TIMEOUT,
  );
}

function deleteBranch<E>(
  cli: BranchCli<E>,
  project: LiveProject,
  target: string,
  phase: string,
): Effect.Effect<true, BranchError<E>, never> {
  const response: Effect.Effect<BranchCliResult, E, never> = cli(
    ["branches", "delete", target, "--project-ref", project.ref, "--yes"],
    {
      exitTimeoutMs: COMMAND_TIMEOUT,
    },
  );
  return response.pipe(
    Effect.flatMap((result): Effect.Effect<true, BranchError<E>, never> => {
      if (result.exitCode === 0) return Effect.succeed(true as const);
      if (isNotFound(result)) return Effect.fail(new BranchNotReady({ phase }));
      return Effect.fail(
        new BranchCommandFailed({
          phase,
          exitCode: result.exitCode,
          stderr: boundedStderr(result.stderr),
        }),
      );
    }),
  );
}

function branchIsListed<E>(
  cli: BranchCli<E>,
  project: LiveProject,
  target: string,
  field: "project_ref" | "name",
): Effect.Effect<boolean, BranchError<E>, never> {
  return listBranches(cli, project, "branches list while awaiting branch removal").pipe(
    Effect.map((branches) => branches.some((branch) => branch[field] === target)),
  );
}

function removeBranchEffect<E>(
  cli: BranchCli<E>,
  project: LiveProject,
  target: string,
  field: "project_ref" | "name",
  deletionAcknowledged: boolean,
): Effect.Effect<true, BranchError<E>, never> {
  const waitForList = Effect.retry(
    Effect.suspend(() =>
      branchIsListed(cli, project, target, field).pipe(
        Effect.flatMap((listed) =>
          listed
            ? Effect.fail(new BranchNotReady({ phase: `branches list removal ${target}` }))
            : Effect.succeed(true as const),
        ),
      ),
    ),
    {
      schedule: Schedule.spaced(POLL_INTERVAL),
      while: (error) => error instanceof BranchNotReady,
    },
  );
  const acknowledged = deletionAcknowledged
    ? waitForList
    : Effect.retry(
        Effect.suspend(() => deleteBranch(cli, project, target, `branches delete ${target}`)),
        {
          schedule: Schedule.spaced(POLL_INTERVAL),
          while: (error) => error instanceof BranchNotReady,
        },
      ).pipe(Effect.flatMap(() => waitForList));
  return Effect.timeoutOrElse(acknowledged, {
    duration: REMOVAL_TIMEOUT,
    orElse: () => Effect.fail(new BranchPollTimedOut({ phase: `branch removal ${target}` })),
  });
}

/** Deletes an owned branch by its unique test name and confirms LIST absence. */
export function removeLiveBranchByNameEffect<E>(
  cli: BranchCli<E>,
  project: LiveProject,
  name: string,
): Effect.Effect<true, BranchError<E>, never> {
  return removeBranchEffect(cli, project, name, "name", false);
}

/** Confirms deletion using the owned ref, then waits for LIST to omit that ref. */
export function awaitLiveBranchRemovedEffect<E>(
  cli: BranchCli<E>,
  project: LiveProject,
  branchRef: string,
  deletionAcknowledged = false,
): Effect.Effect<true, BranchError<E>, never> {
  return removeBranchEffect(cli, project, branchRef, "project_ref", deletionAcknowledged);
}

/** Waits for LIST to contain only the default project. */
export function awaitLiveBranchesRemovedEffect<E>(
  cli: BranchCli<E>,
  project: LiveProject,
): Effect.Effect<true, BranchError<E>, never> {
  const read = listBranches(cli, project, "branches list while awaiting branch removal").pipe(
    Effect.flatMap((branches) =>
      branches.some((branch) => branch["is_default"] !== true)
        ? Effect.fail(new BranchNotReady({ phase: "branches list while awaiting branch removal" }))
        : Effect.succeed(true as const),
    ),
  );
  return poll(
    "branches list while awaiting branch removal",
    Effect.suspend(() => read),
    REMOVAL_TIMEOUT,
  );
}
