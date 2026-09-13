import * as nodePath from "node:path";

import { splitBucketPrefix, storageIsDir } from "../../../command-internal/storage-url.ts";

/** Pure destination-key resolution for `storage cp` recursive uploads. */

export interface UploadDstPathInput {
  /** The destination object path (e.g. `/private/dir/`). */
  readonly remotePath: string;
  /** Path of the current file relative to `localPath`; `"."` when `localPath` is the file itself. */
  readonly relPath: string;
  /** Base name of the current file, used in the single-file branch. */
  readonly fileName: string;
  /** Base name of the walk root. */
  readonly baseName: string;
  /** `remotePath` with any trailing slash removed. */
  readonly noSlash: string;
  /** Whether `base(noSlash)` exists as a directory at the destination. */
  readonly dirExists: boolean;
  /** Whether `base(noSlash)` exists as a file at the destination. */
  readonly fileExists: boolean;
}

/**
 * Resolves the remote destination key for one walked file:
 *  - single file (`relPath === "."`): append the file name only when the destination prefix is
 *    itself a directory, or the destination dir exists and no same-named file does;
 *  - otherwise: nest under `baseName` when the destination dir exists (or the destination is a
 *    bare bucket), then append the relative path.
 *
 * Remote keys use POSIX join semantics; the relative segment's OS separators are normalized to `/`.
 */
export function resolveUploadDstPath(input: UploadDstPathInput): string {
  let dstPath = input.remotePath;
  if (input.relPath === ".") {
    const [, prefix] = splitBucketPrefix(dstPath);
    if (storageIsDir(prefix) || (input.dirExists && !input.fileExists)) {
      dstPath = nodePath.posix.join(dstPath, input.fileName);
    }
    return dstPath;
  }
  if (input.baseName !== "." && (input.dirExists || input.noSlash.length === 0)) {
    dstPath = nodePath.posix.join(dstPath, input.baseName);
  }
  const relPosix = input.relPath.split(nodePath.sep).join(nodePath.posix.sep);
  return nodePath.posix.join(dstPath, relPosix);
}
