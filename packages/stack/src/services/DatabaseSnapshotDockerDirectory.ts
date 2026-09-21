import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Crypto, Data, Effect, Schema, Scope, Stream } from "effect";
import { SnapshotDescriptor } from "./DatabaseSnapshot.ts";

export class DockerDirectorySnapshotError extends Data.TaggedError("DockerDirectorySnapshotError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

type CopyMode = "copy" | "clone";
type Phase = { readonly phase: string; readonly milliseconds: number };
type Helper = { readonly id: string };

const errorFor = (operation: string, cause: unknown) =>
  cause instanceof DockerDirectorySnapshotError
    ? cause
    : new DockerDirectorySnapshotError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const relativeId = (value: string) => {
  const id = value.split(/[\\/]/u).at(-1) ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) ? id : undefined;
};
const treeCheck = (root: string) =>
  `test -d ${shellQuote(root)} && test ! -L ${shellQuote(root)} && test -f ${shellQuote(`${root}/PG_VERSION`)} && test "$(cat ${shellQuote(`${root}/PG_VERSION`)})" = 17 && test ! -e ${shellQuote(`${root}/postmaster.pid`)} && test -z "$(find ${shellQuote(root)} ! -type f ! -type d -print -quit)"`;
const stagedCopy = (
  mode: CopyMode,
  source: string,
  target: string,
  token: string,
  descriptor?: string,
) => {
  const flag = mode === "clone" ? "--reflink=auto" : "--reflink=never";
  const tmp = `${target}.tmp-${token}`;
  return [
    "set -eu",
    treeCheck(`${source}/data`),
    `test ! -e ${shellQuote(target)}`,
    `trap 'rm -rf ${shellQuote(tmp).replaceAll("'", "'\\''")}' EXIT`,
    `mkdir -p ${shellQuote(tmp)}`,
    `cp -a ${flag} ${shellQuote(`${source}/data`)} ${shellQuote(`${tmp}/data`)}`,
    ...(descriptor === undefined
      ? []
      : [
          `mkdir ${shellQuote(`${tmp}/metadata`)}`,
          `printf '%s' ${shellQuote(descriptor)} > ${shellQuote(`${tmp}/metadata/descriptor.json`)}`,
        ]),
    `mv -T -n ${shellQuote(tmp)} ${shellQuote(target)}`,
    `test ! -d ${shellQuote(tmp)}`,
  ].join(" && ");
};

export const makeDockerDirectorySession = Effect.fn("DatabaseSnapshotDockerDirectory.make")(
  function* (options: {
    readonly volume: string;
    readonly reuse: boolean;
    readonly copyMode: CopyMode;
    readonly onPhase?: (event: Phase) => void;
  }) {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const image = "oven/bun:1.4.1-slim";
    const token = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => errorFor("identity", cause)),
    );
    const run = (args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make("docker", args, { stdin: "ignore" }),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [
              child.stdout.pipe(
                Stream.decodeText,
                Stream.runFold(
                  () => "",
                  (all, chunk) => all + chunk,
                ),
              ),
              child.stderr.pipe(
                Stream.decodeText,
                Stream.runFold(
                  () => "",
                  (all, chunk) => all + chunk,
                ),
              ),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (Number(code) !== 0)
            return yield* errorFor("docker", stderr.trim() || `docker exited ${code}`);
          return stdout.trim();
        }),
      ).pipe(Effect.mapError((cause) => errorFor("docker", cause)));
    const phase = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const started = performance.now();
        return effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              options.onPhase?.({ phase: name, milliseconds: performance.now() - started });
            }),
          ),
        );
      });
    const createHelper = Effect.gen(function* () {
      const helper = yield* Effect.acquireRelease(
        run([
          "create",
          "--mount",
          `type=volume,source=${options.volume},target=/workspace`,
          "--entrypoint",
          "/bin/sh",
          image,
          "-c",
          "exec sleep infinity",
        ]).pipe(Effect.map((id) => ({ id }))),
        (owned: Helper) =>
          phase("helper-teardown", run(["rm", "-f", owned.id])).pipe(Effect.ignore),
      );
      yield* run(["start", helper.id]);
      return helper;
    });
    const persistent = options.reuse ? yield* phase("helper-setup", createHelper) : undefined;
    const withHelper = <A>(
      operation: (helper: Helper) => Effect.Effect<A, DockerDirectorySnapshotError, Scope.Scope>,
    ) =>
      persistent === undefined
        ? Effect.scoped(Effect.flatMap(phase("helper-setup", createHelper), operation))
        : operation(persistent);
    const exec = (helper: Helper, script: string) =>
      phase("exec", run(["exec", helper.id, "/bin/sh", "-c", script]));
    const session = {
      forInstance: (instance: string) => {
        const instanceId = relativeId(instance);

        const root = `/workspace/${instanceId}`;
        const exportSnapshot = Effect.fn("DockerDirectorySnapshot.export")(function* ({
          destination,
        }: {
          readonly destination: string;
        }) {
          if (instanceId === undefined)
            return yield* errorFor("export", "Invalid instance identifier");
          const snapshotId = relativeId(destination);
          if (snapshotId === undefined)
            return yield* errorFor("export", "Invalid snapshot identifier");
          const descriptor: Schema.Schema.Type<typeof SnapshotDescriptor> = {
            format: "supabase-database-snapshot-v1",
            version: "17.6.1.173",
            runtime: "docker",
            platform: process.platform,
            arch: process.arch,
            profile: "supabase",
          };
          const descriptorText = yield* Schema.encodeEffect(
            Schema.fromJsonString(SnapshotDescriptor),
          )(descriptor).pipe(Effect.mapError((cause) => errorFor("descriptor", cause)));
          const target = `/workspace/snapshots/${snapshotId}`;
          yield* withHelper((helper) =>
            exec(
              helper,
              `mkdir -p /workspace/snapshots && ${stagedCopy(options.copyMode, root, target, token, descriptorText)}`,
            ),
          );
          return { descriptor, destination };
        });
        const restoreSnapshot = Effect.fn("DockerDirectorySnapshot.restore")(function* ({
          source,
        }: {
          readonly source: string;
        }) {
          if (instanceId === undefined)
            return yield* errorFor("restore", "Invalid instance identifier");
          const snapshotId = relativeId(source);
          if (snapshotId === undefined)
            return yield* errorFor("restore", "Invalid snapshot identifier");
          return yield* withHelper((helper) =>
            Effect.gen(function* () {
              const snapshotRoot = `/workspace/snapshots/${snapshotId}`;
              const descriptorText = yield* exec(
                helper,
                `test ! -L ${shellQuote(snapshotRoot)} && test ! -L ${shellQuote(`${snapshotRoot}/metadata`)} && test ! -L ${shellQuote(`${snapshotRoot}/metadata/descriptor.json`)} && cat ${shellQuote(`${snapshotRoot}/metadata/descriptor.json`)}`,
              );
              const descriptor = yield* Schema.decodeEffect(
                Schema.fromJsonString(SnapshotDescriptor),
              )(descriptorText).pipe(Effect.mapError((cause) => errorFor("descriptor", cause)));
              if (
                descriptor.version !== "17.6.1.173" ||
                descriptor.runtime !== "docker" ||
                descriptor.platform !== process.platform ||
                descriptor.arch !== process.arch ||
                descriptor.profile !== "supabase"
              )
                return yield* errorFor("descriptor", "Snapshot is incompatible with this runtime");
              const stage = `${root}.restore-${token}`;
              yield* exec(
                helper,
                [
                  "set -eu",
                  `test ! -L ${shellQuote(root)}`,
                  `mkdir -p ${shellQuote(root)}`,
                  `if test -e ${shellQuote(`${root}/data`)}; then test ! -L ${shellQuote(`${root}/data`)} && test -d ${shellQuote(`${root}/data`)} && test -z "$(find ${shellQuote(`${root}/data`)} -mindepth 1 -print -quit)"; fi`,
                  stagedCopy(options.copyMode, snapshotRoot, stage, token),
                  `if test -d ${shellQuote(`${root}/data`)}; then rmdir ${shellQuote(`${root}/data`)}; fi`,
                  `mv -T -n ${shellQuote(`${stage}/data`)} ${shellQuote(`${root}/data`)}`,
                  `rmdir ${shellQuote(stage)}`,
                ].join(" && "),
              );
              return { descriptor, destination: source };
            }),
          );
        });
        return { exportSnapshot, restoreSnapshot };
      },
      probeCloning: withHelper((helper) =>
        Effect.gen(function* () {
          const probeToken = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) => errorFor("identity", cause)),
          );
          const probe = `/workspace/.snapshot-probe-${probeToken}`;
          return yield* exec(
            helper,
            `set -eu; trap 'rm -rf ${probe}' EXIT; mkdir ${probe}; printf probe > ${probe}/source; cp --reflink=always ${probe}/source ${probe}/clone`,
          ).pipe(
            Effect.as(true),
            Effect.catchTag("DockerDirectorySnapshotError", () => Effect.succeed(false)),
          );
        }),
      ),
    };
    return session;
  },
);
