// oxlint-disable-next-line effecttsgo/node-builtin-import -- supervisor bootstrap log opens before Effect services exist.
import * as NodeFs from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- path join for the stack-owned bootstrap log.
import * as NodePath from "node:path";

export const SUPERVISOR_BOOTSTRAP_LOG = "bootstrap.log";
export const SUPERVISOR_BOOTSTRAP_LOG_MAX_BYTES = 256 * 1024;

export interface SupervisorBootstrapLog {
  readonly fd: number;
  readonly path: string;
}

/** Opens a capped owner-only bootstrap log under `<stateRoot>/<stackId>/`. */
export const openSupervisorBootstrapLog = (
  stateRoot: string,
  stackId: string,
): SupervisorBootstrapLog | undefined => {
  try {
    const stackRoot = NodePath.join(stateRoot, stackId);
    NodeFs.mkdirSync(stackRoot, { recursive: true, mode: 0o700 });
    const path = NodePath.join(stackRoot, SUPERVISOR_BOOTSTRAP_LOG);
    let fd = NodeFs.openSync(path, "a", 0o600);
    try {
      NodeFs.fchmodSync(fd, 0o600);
    } catch {
      // Open mode applies on create; fchmod can fail on some filesystems.
    }
    if (NodeFs.fstatSync(fd).size > SUPERVISOR_BOOTSTRAP_LOG_MAX_BYTES) {
      NodeFs.closeSync(fd);
      fd = NodeFs.openSync(path, "w", 0o600);
      try {
        NodeFs.fchmodSync(fd, 0o600);
      } catch {
        // Open mode applies on truncate; fchmod can fail on some filesystems.
      }
    }
    return { fd, path };
  } catch {
    return undefined;
  }
};
