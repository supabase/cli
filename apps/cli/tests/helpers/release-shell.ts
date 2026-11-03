import { Data, Effect, Exit, Schema } from "effect";

export class ReleaseStepError extends Data.TaggedError("ReleaseStepError")<{
  readonly cause: unknown;
}> {}

export const releaseStep = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ReleaseStepError({ cause }) });

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** `JSON.stringify` of captured output; encoding a string cannot fail. */
export const jsonQuote = (text: string) => encodeJson(text).pipe(Effect.orDie);

export const runCliEffect = Effect.fn("ReleaseShell.runCli")(function* (
  binPath: string,
  args: Array<string>,
) {
  /* The scope owns the child: an interrupted run kills it and waits for it to exit. */
  const proc = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn([binPath, ...args], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: (cause) => new ReleaseStepError({ cause }),
    }),
    (spawned, exit) =>
      Exit.hasInterrupts(exit)
        ? Effect.sync(() => spawned.kill("SIGKILL")).pipe(
            Effect.andThen(Effect.promise(() => spawned.exited)),
          )
        : Effect.void,
  );

  const [stdout, stderr, exitCode] = yield* releaseStep(() =>
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
  );

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}, Effect.scoped);

export const verifyExpectedShellEffect = Effect.fn("ReleaseShell.verifyExpectedShell")(function* (
  binPath: string,
) {
  const result = yield* runCliEffect(binPath, ["init", "--help"]);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const passed = result.exitCode === 0 && output.includes("init");
  return {
    passed,
    detail: passed
      ? 'dispatch ok: "init --help" succeeded'
      : `expected dispatch via "init --help", got exit=${result.exitCode}, stdout=${yield* jsonQuote(result.stdout)}, stderr=${yield* jsonQuote(result.stderr)}`,
  };
});
