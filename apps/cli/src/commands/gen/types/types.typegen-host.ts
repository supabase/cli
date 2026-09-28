import {
  type Host,
  isWindowsScript,
  quoteForCmd,
  resolveWindowsCommand,
  type SpawnRequest,
  type SpawnResult,
} from "@supabase/typegen";
import { Effect, Predicate, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

import { collectText } from "../../../command-internal/container-cli.ts";

export interface TypegenHostOptions {
  /** Where out-of-process tools run: the directory the command was invoked from. */
  readonly cwd: string;
  /** What the registry's Windows lookup reads; the child inherits the full environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** `Effect.runPromiseWith(context)` from the generator fiber, so it owns the spawned tool. */
  readonly runPromise: <A>(
    effect: Effect.Effect<A>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<A>;
}

type TypegenSpawnOutcome =
  | { readonly _tag: "Exited"; readonly result: SpawnResult }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Failed"; readonly error: unknown };

const isNotFound = (error: unknown): boolean =>
  Predicate.hasProperty(error, "reason") && Predicate.isTagged(error.reason, "NotFound");

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
        // `spawn` cannot start the `.bat` Flutter ships `dart` as without a shell.
        const resolved = resolveWindowsCommand(request.command, request.env);
        if (resolved === undefined) return { _tag: "NotFound" } as const;
        shell = isWindowsScript(resolved);
        command = shell ? quoteForCmd(resolved) : resolved;
        if (shell) args = request.args.map(quoteForCmd);
      }
      const child = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd: request.cwd,
          env: request.env,
          extendEnv: true,
          shell,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      // Written here rather than handed to the spawner, so a tool that exits before reading its
      // input fails the write in this fiber, where it is expected, instead of in a forked one.
      const feedStdin = Stream.run(
        Stream.make(new TextEncoder().encode(request.stdin)),
        child.stdin,
      ).pipe(Effect.ignore);
      const [, stdout, stderr, exitCode] = yield* Effect.all(
        [
          feedStdin,
          collectText(child.stdout),
          collectText(child.stderr),
          // A signal-ended process fails `exitCode`; the registry's contract wants `null`.
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

const commandNotFound = (command: string): Error =>
  Object.assign(new Error(`spawn ${command} ENOENT`), {
    code: "ENOENT",
    syscall: `spawn ${command}`,
    path: command,
  });

/** The registry `Host` for `gen types`; TypeScript is handed back unformatted, `oxfmt` stays out. */
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
