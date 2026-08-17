import { randomUUID } from "node:crypto";
import { link, unlink, writeFile } from "node:fs/promises";
import { errorCode } from "./error-code.ts";

export type FileClaimOutcome = "claimed" | "already-exists";

export interface FileClaimOptions {
  /** Mode for the published file; defaults to the process umask. */
  readonly mode?: number;
  /**
   * The hardlink step, overridable so a test can drive the hardlink-less
   * fallback on a filesystem that does support hardlinks.
   */
  readonly linkFile?: (existingPath: string, newPath: string) => Promise<void>;
}

const createExclusively = async (
  targetPath: string,
  content: string,
  mode: number | undefined,
): Promise<FileClaimOutcome> => {
  try {
    await writeFile(targetPath, content, { flag: "wx", mode });
    return "claimed";
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") {
      return "already-exists";
    }
    throw error;
  }
};

/**
 * Publishes `content` at `targetPath` unless a claimant got there first.
 *
 * The content is written to a sibling temporary file and hardlinked into place,
 * because `link` publishes the whole file in one step and refuses an existing
 * target: writing `targetPath` directly could crash halfway and publish a
 * partial claim, and testing for the file before writing it would lose the very
 * race the claim exists to settle. Filesystems without hardlinks — exFAT,
 * FAT32, some network mounts — refuse `link` with `EPERM` or `ENOTSUP`; those
 * fall back to an exclusive create, which still settles the race but gives up
 * the all-or-nothing publish. Any other failure is a real one and propagates.
 *
 * A `SIGKILL` between the temporary write and its removal strands a
 * `.tmp.<id>` sibling. Nothing ever reads those, so a stranded one is junk
 * rather than a claim anybody can observe, and every attempt gets a fresh
 * temporary path so a concurrent claimant cannot overwrite its source.
 */
export const claimFileAtomically = async (
  targetPath: string,
  content: string,
  options: FileClaimOptions = {},
): Promise<FileClaimOutcome> => {
  const linkFile = options.linkFile ?? link;
  const temporaryPath = `${targetPath}.tmp.${randomUUID()}`;
  await writeFile(temporaryPath, content, { mode: options.mode });
  try {
    await linkFile(temporaryPath, targetPath);
    return "claimed";
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      return "already-exists";
    }
    if (code !== "EPERM" && code !== "ENOTSUP") {
      throw error;
    }
    return await createExclusively(targetPath, content, options.mode);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};
