import { constants, copyFileSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sourceRoot = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "snapshot-probe-"));
const alternateParent = join(process.env.LOCALAPPDATA, "Temp");
await mkdir(alternateParent, { recursive: true });
const alternateRoot = await mkdtemp(join(alternateParent, "snapshot-probe-"));
try {
  const source = join(sourceRoot, "source");
  await writeFile(source, Buffer.alloc(1024 * 1024, 42));
  console.log(
    JSON.stringify({
      runtime: process.versions,
      sourceRoot,
      alternateRoot,
      flags: {
        ordinary: 0,
        clone: constants.COPYFILE_FICLONE,
        force: constants.COPYFILE_FICLONE_FORCE,
      },
    }),
  );
  for (const mode of [0, constants.COPYFILE_FICLONE, constants.COPYFILE_FICLONE_FORCE, 4]) {
    for (const async of [false, true]) {
      for (const [volume, root] of [
        ["same", sourceRoot],
        ["other", alternateRoot],
      ]) {
        const destination = join(root, `copy-${mode}-${async}`);
        await rm(destination, { force: true });
        try {
          if (async) await copyFile(source, destination, mode);
          else copyFileSync(source, destination, mode);
          console.log(
            JSON.stringify({
              mode: String(mode),
              async,
              volume,
              result: "success",
              bytes: (await readFile(destination)).length,
            }),
          );
        } catch (error) {
          console.log(
            JSON.stringify({
              mode: String(mode),
              async,
              volume,
              result: "error",
              code: error.code,
              message: error.message,
            }),
          );
        }
      }
    }
  }
} finally {
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(alternateRoot, { recursive: true, force: true });
}
