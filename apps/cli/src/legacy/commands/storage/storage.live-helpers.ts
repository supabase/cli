/** Flags every storage live test passes: the suite links the shared project
 * and the storage command family is experimental-gated. */
export const legacyStorageLiveFlags: ReadonlyArray<string> = ["--linked", "--experimental"];

/**
 * Best-effort exact-object cleanup for storage live tests: removes one owned
 * remote object, tolerating an already-removed target so teardown stays
 * idempotent across the moved/renamed paths a test may leave behind.
 */
export async function legacyRemoveStorageLiveObject(
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  remote: string,
): Promise<void> {
  const removed = await cli(["storage", "rm", remote, "--yes", ...legacyStorageLiveFlags]);
  if (
    removed.exitCode !== 0 &&
    !/not found|does not exist/i.test(`${removed.stdout}\n${removed.stderr}`)
  ) {
    throw new Error(`storage rm cleanup failed:\n${removed.stdout}\n${removed.stderr}`);
  }
}
