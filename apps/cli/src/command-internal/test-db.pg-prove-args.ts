import * as nodePath from "node:path";
import { Option } from "effect";

import { toDockerMountPath } from "./docker-path.ts";

export interface PgProveArgs {
  /** Full `pg_prove` argv (without the leading binary, which the image provides). */
  readonly cmd: ReadonlyArray<string>;
  /** Docker volume binds, each `hostpath:dockerpath:ro`. */
  readonly binds: ReadonlyArray<string>;
  /**
   * The searched paths as they exist on the host, for diagnostics — not the
   * `toDockerMountPath` form used in `cmd`, which strips the volume name on
   * Windows and would point an error at a path the user doesn't have.
   */
  readonly hostPaths: ReadonlyArray<string>;
  /** Container working directory (dir of the first test path). */
  readonly workingDir: Option.Option<string>;
}

/**
 * Builds the `pg_prove` command, volume binds, and working directory for a
 * `test db` run.
 *
 * - No paths defaults to `<workdir>/supabase/tests`.
 * - Relative paths resolve against `cwd`, the original invocation directory.
 * - `--verbose` is appended when debug logging is enabled.
 *
 * For a file path, the bind mounts its parent directory (not the lone file),
 * so psql `\ir`/`\i` includes to a sibling file resolve; the full path is
 * still passed to `pg_prove`.
 */
export function buildPgProveArgs(opts: {
  readonly paths: ReadonlyArray<string>;
  readonly cwd: string;
  readonly workdir: string;
  readonly debug: boolean;
}): PgProveArgs {
  const testFiles =
    opts.paths.length > 0 ? opts.paths : [nodePath.resolve(opts.workdir, "supabase", "tests")];

  const cmd: string[] = ["pg_prove", "--ext", ".pg", "--ext", ".sql", "-r"];
  const binds: string[] = [];
  const hostPaths: string[] = [];
  const seenTargets = new Set<string>();
  // `testFiles` is never empty (it defaults to supabase/tests), so the first
  // iteration always sets this.
  let workingDir = "";

  for (const candidate of testFiles) {
    const fp = nodePath.isAbsolute(candidate) ? candidate : nodePath.join(opts.cwd, candidate);
    const dockerPath = toDockerMountPath(fp);
    cmd.push(dockerPath);
    hostPaths.push(fp);

    // Mount the directory containing a test file (not the lone file) so psql
    // `\ir ./sibling.sql` includes resolve relative to the test file's own
    // directory; a single-file bind would leave siblings absent in the
    // container. Directories are mounted as-is.
    const isFile = nodePath.posix.extname(dockerPath) !== "";
    const hostMount = isFile ? nodePath.dirname(fp) : fp;
    const dockerMount = toDockerMountPath(hostMount);

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

  return { cmd, binds, hostPaths, workingDir: Option.some(workingDir) };
}
