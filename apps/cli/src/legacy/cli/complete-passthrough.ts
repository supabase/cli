import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import process from "node:process";
import {
  type BinaryResolution,
  formatGoBinaryNotFoundError,
  resolveBinary,
} from "../../shared/legacy/go-proxy.layer.ts";

export interface CompletePassthroughDeps {
  readonly argv: ReadonlyArray<string>;
  readonly resolveBinary: () => BinaryResolution;
  readonly spawn: (cmd: string, args: ReadonlyArray<string>) => SpawnSyncReturns<Buffer>;
  readonly stderrWrite: (message: string) => void;
  readonly exit: (code: number) => void;
}

/**
 * Cobra-generated completion scripts (`supabase completion {bash,zsh,fish,powershell}`)
 * call back into `supabase __complete <args>` on every tab press. The args may
 * include partial flag tokens (e.g. `--de` while the user is mid-completion of a
 * flag name) that Effect's structured parser would reject. Bypass Effect entirely
 * for this code path and proxy the raw argv to the bundled Go binary, which is
 * the authority on completion behavior for the legacy shell.
 *
 * Returns `true` when the call was intercepted (caller must not continue), `false`
 * otherwise.
 */
export function tryCompletePassthrough(deps: CompletePassthroughDeps): boolean {
  if (deps.argv[0] !== "__complete") return false;

  const resolved = deps.resolveBinary();
  if (!("found" in resolved)) {
    deps.stderrWrite(`${formatGoBinaryNotFoundError(resolved.notFound)}\n`);
    deps.exit(1);
    return true;
  }

  const result = deps.spawn(resolved.found, deps.argv);
  if (result.error) {
    deps.stderrWrite(`${result.error.message}\n`);
    deps.exit(1);
    return true;
  }
  deps.exit(result.status ?? 1);
  return true;
}

export function defaultCompletePassthroughDeps(): CompletePassthroughDeps {
  return {
    argv: process.argv.slice(2),
    resolveBinary,
    spawn: (cmd, args) => spawnSync(cmd, [...args], { stdio: "inherit" }),
    stderrWrite: (message) => {
      process.stderr.write(message);
    },
    exit: (code) => {
      process.exit(code);
    },
  };
}
