import * as nodePath from "node:path";

import { legacySplitBucketPrefix, legacyStorageIsDir } from "../../../shared/legacy-storage-url.ts";

/**
 * Pure destination-key resolution for `storage cp` recursive uploads, ported from
 * Go's `UploadStorageObjectAll` walk callback (`internal/storage/cp/cp.go:124-148`).
 * Kept free of Effect/services so the Go-parity branch matrix stays unit-testable.
 */

export interface LegacyUploadDstPathInput {
  /** The destination object path (`dstParsed.Path`, e.g. `/private/dir/`). */
  readonly remotePath: string;
  /** `filepath.Rel(localPath, filePath)` — `"."` when `localPath` is the file itself. */
  readonly relPath: string;
  /** Base name of the current file (`info.Name()`), used in the single-file branch. */
  readonly fileName: string;
  /** Base name of the walk root (`filepath.Base(localPath)`). */
  readonly baseName: string;
  /** `strings.TrimSuffix(remotePath, "/")`. */
  readonly noSlash: string;
  /** Whether `base(noSlash)` exists as a directory at the destination. */
  readonly dirExists: boolean;
  /** Whether `base(noSlash)` exists as a file at the destination. */
  readonly fileExists: boolean;
}

/**
 * Resolve the remote destination key for one walked file (`cp.go:135-148`):
 *  - single file (`relPath === "."`): append the file name only when the
 *    destination prefix is itself a directory, or the destination dir exists and
 *    no same-named file does;
 *  - otherwise: nest under `baseName` when the destination dir exists (or the
 *    destination is a bare bucket), then append the relative path.
 *
 * Remote keys are joined with POSIX semantics (Go uses `path.Join`); the relative
 * segment's OS separators are normalised to `/`.
 */
export function legacyResolveUploadDstPath(input: LegacyUploadDstPathInput): string {
  let dstPath = input.remotePath;
  if (input.relPath === ".") {
    const [, prefix] = legacySplitBucketPrefix(dstPath);
    if (legacyStorageIsDir(prefix) || (input.dirExists && !input.fileExists)) {
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
