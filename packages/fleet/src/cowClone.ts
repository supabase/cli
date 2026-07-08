import { spawn } from "node:child_process";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const run = (cmd: string, args: string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

export interface CloneDirOptions {
  /**
   * Overrides the executable used for the platform-specific copy-on-write attempt
   * (`cp` by default). Test-only seam: lets tests force the CoW step to fail
   * deterministically (e.g. `"false"`, or a stub script) so the fallback path —
   * including its pre-fallback cleanup of any partially-written `dest` — can be
   * exercised without depending on filesystem-specific CoW failure conditions.
   */
  cowCommand?: string;
}

/** Copy-on-write directory clone: APFS clonefile on macOS, reflink on Linux, plain copy fallback. */
export async function cloneDir(
  src: string,
  dest: string,
  options?: CloneDirOptions,
): Promise<void> {
  const exists = await stat(dest).then(
    () => true,
    () => false,
  );
  if (exists) throw new Error(`cloneDir: destination already exists: ${dest}`);
  await mkdir(dirname(dest), { recursive: true });

  const cowCommand = options?.cowCommand ?? "cp";
  let attemptedCow = false;

  if (process.platform === "darwin") {
    attemptedCow = true;
    if ((await run(cowCommand, ["-Rc", src, dest])) === 0) return;
  } else if (process.platform === "linux") {
    attemptedCow = true;
    if ((await run(cowCommand, ["-R", "--reflink=auto", src, dest])) === 0) return;
  } else if (options?.cowCommand) {
    // No platform-specific CoW branch would normally run, but tests may still force
    // the seam to exercise the fallback-cleanup path uniformly across platforms.
    attemptedCow = true;
    if ((await run(cowCommand, ["-R", src, dest])) === 0) return;
  }

  // The CoW attempt failed after possibly writing a partial dest (e.g. a clonefile/reflink
  // command that dies partway through a large tree). Remove any such leftovers before
  // falling back, so dest never ends up a silent mix of truncated CoW output and fresh
  // fallback files.
  if (attemptedCow) {
    await rm(dest, { recursive: true, force: true });
  }

  // Fallback (non-CoW filesystems, other platforms): plain recursive copy.
  // `verbatimSymlinks: true` preserves relative symlink targets as-is; the default
  // (false) rewrites them to absolute paths pointing back into `src`, making the
  // clone silently depend on its source tree.
  await cp(src, dest, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
}
