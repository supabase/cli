import { spawn } from "node:child_process";
import { cp, stat } from "node:fs/promises";

const run = (cmd: string, args: string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

/** Copy-on-write directory clone: APFS clonefile on macOS, reflink on Linux, plain copy fallback. */
export async function cloneDir(src: string, dest: string): Promise<void> {
  const exists = await stat(dest).then(
    () => true,
    () => false,
  );
  if (exists) throw new Error(`cloneDir: destination already exists: ${dest}`);

  if (process.platform === "darwin") {
    if ((await run("cp", ["-Rc", src, dest])) === 0) return;
  } else if (process.platform === "linux") {
    if ((await run("cp", ["-R", "--reflink=auto", src, dest])) === 0) return;
  }
  // Fallback (non-CoW filesystems, other platforms): plain recursive copy.
  await cp(src, dest, { recursive: true, force: false, errorOnExist: true });
}
