import { Data, Effect, Schema } from "effect";

type ShellCheckResult = {
  readonly passed: boolean;
  readonly detail: string;
};

export interface CliRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class ReleaseStepError extends Data.TaggedError("ReleaseStepError")<{
  readonly cause: unknown;
}> {}

export const releaseStep = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ReleaseStepError({ cause }) });

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** `JSON.stringify` of captured output; encoding a string cannot fail. */
export const jsonQuote = (text: string) => encodeJson(text).pipe(Effect.orDie);

/* Promise facades reject with the original thrown value. */
const runAsPromise = <A>(effect: Effect.Effect<A, ReleaseStepError>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.catch((error) => Effect.die(error.cause))));

export const runCliEffect = Effect.fn("ReleaseShell.runCli")(function* (
  binPath: string,
  args: Array<string>,
) {
  const proc = yield* Effect.try({
    try: () =>
      Bun.spawn([binPath, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    catch: (cause) => new ReleaseStepError({ cause }),
  });

  const [stdout, stderr, exitCode] = yield* releaseStep(() =>
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
  );

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
});

export function runCli(binPath: string, args: Array<string>): Promise<CliRunResult> {
  return runAsPromise(runCliEffect(binPath, args));
}

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

export function verifyExpectedShell(binPath: string): Promise<ShellCheckResult> {
  return runAsPromise(verifyExpectedShellEffect(binPath));
}
