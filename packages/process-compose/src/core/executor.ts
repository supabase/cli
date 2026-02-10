import { spawn, type Subprocess } from "bun";

interface SpawnOptions {
  command: string;
  env?: Record<string, string>;
  cwd?: string;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface SpawnedProcess {
  proc: Subprocess;
  pid: number;
  waitForExit: () => Promise<number>;
  kill: (signal?: number) => void;
}

/**
 * Spawn a process using shell execution
 */
export function spawnProcess(options: SpawnOptions): SpawnedProcess {
  const { command, env = {}, cwd, onStdout, onStderr } = options;

  const proc = spawn({
    cmd: ["sh", "-c", command],
    env: { ...Bun.env, ...env },
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Stream stdout
  if (proc.stdout && onStdout) {
    void streamOutput(proc.stdout, onStdout);
  }

  // Stream stderr
  if (proc.stderr && onStderr) {
    void streamOutput(proc.stderr, onStderr);
  }

  const waitForExit = async (): Promise<number> => {
    const code = await proc.exited;
    return code;
  };

  const kill = (signal: number = 15): void => {
    try {
      // Kill the process group (negative PID)
      // This ensures child processes are also terminated
      process.kill(-proc.pid, signal);
    } catch {
      // Process may already be dead
      try {
        proc.kill(signal);
      } catch {
        // Ignore
      }
    }
  };

  return {
    proc,
    pid: proc.pid,
    waitForExit,
    kill,
  };
}

/**
 * Stream output from a ReadableStream
 */
async function streamOutput(
  stream: ReadableStream<Uint8Array>,
  callback: (data: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      callback(decoder.decode(value, { stream: true }));
    }
  } catch {
    // Stream closed
  } finally {
    reader.releaseLock();
  }
}
