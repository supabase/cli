import * as nodePath from "node:path";
import { Option } from "effect";

export interface LegacyPgProveArgs {
  /** Full `pg_prove` argv (without the leading binary, which the image provides). */
  readonly cmd: ReadonlyArray<string>;
  /** Docker volume binds, each `hostpath:dockerpath:ro`. */
  readonly binds: ReadonlyArray<string>;
  /** Container working directory (dir of the first test path). */
  readonly workingDir: Option.Option<string>;
}

/**
 * Translate an absolute host path to its in-container mount path. Mirrors Go's
 * `utils.ToDockerPath` (`apps/cli-go/internal/utils/deno.go:268`): strip a
 * Windows volume name (`C:`) and convert backslashes to forward slashes.
 */
export function legacyToDockerPath(absHostPath: string): string {
  const slashed = absHostPath.replaceAll("\\", "/");
  const volumeMatch = /^[A-Za-z]:/.exec(absHostPath);
  return volumeMatch === null ? slashed : slashed.slice(volumeMatch[0].length);
}

/**
 * Build the `pg_prove` command, volume binds, and working directory for a
 * `test db` run. Pure port of the loop in `apps/cli-go/internal/db/test/test.go:29-56`.
 *
 * - No paths → default to `<workdir>/supabase/tests` (Go's `filepath.Abs(DbTestsDir)`
 *   after chdir to the project root).
 * - Relative paths resolve against `cwd` (Go's `utils.CurrentDirAbs`, the original
 *   invocation directory).
 * - `--verbose` is appended when debug logging is enabled (Go's `viper.GetBool("DEBUG")`).
 *
 * Intentional divergence from Go (CLI-1139): for a file path we mount its parent
 * *directory* rather than the lone file, so psql `\ir`/`\i` includes resolve. Go
 * mounts the file alone, which breaks single-file runs that include a sibling.
 * Output is unchanged — the full file path is still passed to `pg_prove`.
 */
export function buildLegacyPgProveArgs(opts: {
  readonly paths: ReadonlyArray<string>;
  readonly cwd: string;
  readonly workdir: string;
  readonly debug: boolean;
}): LegacyPgProveArgs {
  const testFiles =
    opts.paths.length > 0 ? opts.paths : [nodePath.resolve(opts.workdir, "supabase", "tests")];

  const cmd: string[] = ["pg_prove", "--ext", ".pg", "--ext", ".sql", "-r"];
  const binds: string[] = [];
  const seenTargets = new Set<string>();
  // `testFiles` is never empty (it defaults to supabase/tests), so the first
  // iteration always sets this; Go derives workingDir from the first path only.
  let workingDir = "";

  for (const candidate of testFiles) {
    const fp = nodePath.isAbsolute(candidate) ? candidate : nodePath.join(opts.cwd, candidate);
    const dockerPath = legacyToDockerPath(fp);
    cmd.push(dockerPath);

    // Mount the *directory* containing a test file (not the lone file) so psql
    // `\ir ./sibling.sql` includes resolve: they look relative to the test file's
    // own directory, and a single-file bind leaves siblings absent in the
    // container (CLI-1139). Directories are mounted as-is. The file-vs-directory
    // heuristic (presence of an extension) matches Go's workingDir logic.
    const isFile = nodePath.posix.extname(dockerPath) !== "";
    const hostMount = isFile ? nodePath.dirname(fp) : fp;
    const dockerMount = legacyToDockerPath(hostMount);

    // Dedupe by container target: two files in the same directory (or a file plus
    // its containing directory) would otherwise emit duplicate `-v` mounts, which
    // Docker rejects.
    if (!seenTargets.has(dockerMount)) {
      seenTargets.add(dockerMount);
      binds.push(`${hostMount}:${dockerMount}:ro`);
    }
    if (workingDir === "") workingDir = dockerMount;
  }

  if (opts.debug) cmd.push("--verbose");

  return { cmd, binds, workingDir: Option.some(workingDir) };
}
