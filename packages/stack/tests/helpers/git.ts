import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Data, Effect, Stream } from "effect";

export class GitSetupError extends Data.TaggedError("GitSetupError")<{
  readonly command: string;
  readonly cwd: string;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}> {}

const decode = (chunks: ReadonlyArray<Uint8Array>): string => {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

/** Disables auto-gc/maintenance so Git never forks a detached writer into `.git/` after this
 *  command returns; test fixtures remove the repository right after these commands finish, and a
 *  detached `gc --auto`/`maintenance run --auto` would still be touching objects and packs then. */
const NO_AUTO_MAINTENANCE = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];

/** Runs Git while draining both output streams, preserving diagnostics on failure. */
export const runGit = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void, GitSetupError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const command = `git ${args.join(" ")}`;
      const child = yield* ChildProcess.make("git", [...NO_AUTO_MAINTENANCE, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(
          (error) =>
            new GitSetupError({
              command,
              cwd,
              stdout: "",
              stderr: "",
              message: `Unable to start ${command}: ${error.message}`,
            }),
        ),
      );
      const [stdoutChunks, stderrChunks, exitCode] = yield* Effect.all(
        [Stream.runCollect(child.stdout), Stream.runCollect(child.stderr), child.exitCode],
        { concurrency: 3 },
      ).pipe(
        Effect.mapError(
          (error) =>
            new GitSetupError({
              command,
              cwd,
              stdout: "",
              stderr: "",
              message: `Unable to complete ${command}: ${error.message}`,
            }),
        ),
      );
      const stdout = decode(Array.from(stdoutChunks));
      const stderr = decode(Array.from(stderrChunks));
      const result = { exitCode, stdout, stderr };
      if (exitCode !== 0) {
        const diagnostics = [
          `${command} exited with code ${exitCode}`,
          stdout.trim().length > 0 ? `stdout: ${stdout.trim()}` : undefined,
          stderr.trim().length > 0 ? `stderr: ${stderr.trim()}` : undefined,
        ]
          .filter((value): value is string => value !== undefined)
          .join("\n");
        return yield* new GitSetupError({ command, cwd, ...result, message: diagnostics });
      }
      return;
    }),
  );
