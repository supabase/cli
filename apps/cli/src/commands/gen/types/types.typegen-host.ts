import {
  resolveWindowsCommand,
  type Host,
  type SpawnRequest,
  type SpawnResult,
} from "@supabase/typegen";
import { Effect, Predicate, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

import { collectText } from "../../../command-internal/container-cli.ts";

export interface TypegenHostOptions {
  /** The user's project directory; out-of-process tools run here. */
  readonly cwd: string;
  /**
   * What the registry's Windows command lookup reads (`PATH`, `PATHEXT`, `ComSpec`). The child
   * itself inherits the full environment through `extendEnv`.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /**
   * Bridges an Effect into the Promise the registry expects. Supplied by the generator layer as
   * `Effect.runPromiseWith(context)` so the bridge stays anchored to the generator fiber, and
   * the request's abort signal interrupts the spawned tool.
   */
  readonly runPromise: <A>(
    effect: Effect.Effect<A>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<A>;
}

type TypegenSpawnOutcome =
  | { readonly _tag: "Exited"; readonly result: SpawnResult }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Failed"; readonly error: unknown };

const WINDOWS_SCRIPT = /\.(bat|cmd)$/i;

/**
 * In shell mode the spawner joins the command and its arguments with spaces into one `cmd.exe /c`
 * line without quoting, so a token holding whitespace must be quoted here.
 */
const quoteForCmd = (token: string): string => (/\s/.test(token) ? `"${token}"` : token);

const isNotFound = (error: unknown): boolean =>
  Predicate.hasProperty(error, "reason") && Predicate.isTagged(error.reason, "NotFound");

/**
 * Runs one registry spawn request through the Effect spawner. Off Windows the command is
 * started as given, so a missing executable is the spawner's own not-found failure. On Windows
 * the command is resolved through `PATH` and `PATHEXT` first, because `spawn` cannot start the
 * `.bat` Flutter ships `dart` as without a shell; a script runs through the command
 * interpreter and a command the lookup cannot find is reported as not found without spawning.
 */
const spawnForTypegen = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  request: SpawnRequest,
  platform: NodeJS.Platform,
): Effect.Effect<TypegenSpawnOutcome> =>
  Effect.scoped(
    Effect.gen(function* () {
      let command = request.command;
      let args: ReadonlyArray<string> = request.args;
      let shell = false;
      if (platform === "win32") {
        const resolved = resolveWindowsCommand(request.command, request.env);
        if (resolved === undefined) return { _tag: "NotFound" } as const;
        shell = WINDOWS_SCRIPT.test(resolved);
        command = shell ? quoteForCmd(resolved) : resolved;
        if (shell) args = request.args.map(quoteForCmd);
      }
      const child = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd: request.cwd,
          env: request.env,
          extendEnv: true,
          shell,
          stdin: Stream.make(new TextEncoder().encode(request.stdin)),
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectText(child.stdout),
          collectText(child.stderr),
          // The spawner fails `exitCode` when a signal ended the process; the registry's
          // `SpawnResult` contract reports that case as a `null` exit code instead.
          child.exitCode.pipe(
            Effect.map(Number),
            Effect.orElseSucceed((): number | null => null),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return { _tag: "Exited", result: { exitCode, stdout, stderr } } as const;
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.succeed<TypegenSpawnOutcome>(
        isNotFound(error) ? { _tag: "NotFound" } : { _tag: "Failed", error },
      ),
    ),
  );

/** The `ENOENT` rejection the registry's `Host.spawn` contract asks for when a command is missing. */
const commandNotFound = (command: string): Error =>
  Object.assign(new Error(`spawn ${command} ENOENT`), {
    code: "ENOENT",
    syscall: `spawn ${command}`,
    path: command,
  });

/**
 * The registry `Host` for `gen types`: spawns through the Effect spawner, and hands TypeScript
 * back unformatted so `oxfmt` stays out of the binary.
 */
export const makeTypegenHost = (options: TypegenHostOptions): Host => ({
  cwd: options.cwd,
  env: options.env,
  spawn: (request) =>
    options
      .runPromise(spawnForTypegen(options.spawner, request, options.platform), {
        signal: request.signal,
      })
      .then((outcome) => {
        switch (outcome._tag) {
          case "Exited":
            return outcome.result;
          case "NotFound":
            throw commandNotFound(request.command);
          case "Failed":
            throw outcome.error;
        }
      }),
  format: (code) => Promise.resolve(code),
});
