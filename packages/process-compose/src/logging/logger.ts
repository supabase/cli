import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface Logger {
  log(processName: string, stream: "stdout" | "stderr", data: string): void;
  getProcessLogs(processName: string, offset?: number, limit?: number): string[];
  truncateProcessLogs(processName: string): void;
  close(): Promise<void>;
}

interface LogEntry {
  timestamp: number;
  processName: string;
  stream: "stdout" | "stderr";
  data: string;
}

const MAX_BUFFER_SIZE = 10000; // Max lines per process

/**
 * Create a logger that writes to disk and buffers in memory
 */
export function createLogger(logFilePath?: string): Logger {
  const logBuffers = new Map<string, LogEntry[]>();
  let fileHandle: Bun.FileSink | null = null;
  let pendingWrites: Promise<void>[] = [];

  async function ensureLogFile(): Promise<void> {
    if (!logFilePath || fileHandle) return;

    // Ensure directory exists
    const dir = dirname(logFilePath);
    await mkdir(dir, { recursive: true });

    // Open file for appending
    const file = Bun.file(logFilePath);
    fileHandle = file.writer();
  }

  function log(processName: string, stream: "stdout" | "stderr", data: string): void {
    const timestamp = Date.now();
    const entry: LogEntry = { timestamp, processName, stream, data };

    // Buffer in memory
    let buffer = logBuffers.get(processName);
    if (!buffer) {
      buffer = [];
      logBuffers.set(processName, buffer);
    }

    // Split by lines and add each
    const lines = data.split("\n");
    for (const line of lines) {
      if (line.length > 0) {
        buffer.push({ ...entry, data: line });
      }
    }

    // Trim buffer if too large
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
    }

    // Write to file asynchronously
    if (logFilePath) {
      const writePromise = writeToFile(entry);
      pendingWrites.push(writePromise);
      void writePromise.finally(() => {
        const idx = pendingWrites.indexOf(writePromise);
        if (idx >= 0) {
          void pendingWrites.splice(idx, 1);
        }
      });
    }
  }

  async function writeToFile(entry: LogEntry): Promise<void> {
    await ensureLogFile();
    if (!fileHandle) return;

    const time = new Date(entry.timestamp).toISOString();
    const prefix = entry.stream === "stderr" ? "[ERR]" : "[OUT]";
    const line = `${time} ${entry.processName} ${prefix} ${entry.data}\n`;

    void fileHandle.write(line);
    void fileHandle.flush();
  }

  function getProcessLogs(processName: string, offset = 0, limit = 100): string[] {
    const buffer = logBuffers.get(processName);
    if (!buffer) return [];

    // If limit is 0, return all from offset
    if (limit === 0) {
      return buffer.slice(offset).map(formatLogEntry);
    }

    // offset is from the end
    const start = Math.max(0, buffer.length - offset - limit);
    const end = buffer.length - offset;

    return buffer.slice(start, end).map(formatLogEntry);
  }

  function formatLogEntry(entry: LogEntry): string {
    const time = new Date(entry.timestamp).toISOString();
    const prefix = entry.stream === "stderr" ? "[ERR]" : "";
    return `${time} ${prefix}${entry.data}`;
  }

  function truncateProcessLogs(processName: string): void {
    logBuffers.set(processName, []);
  }

  async function close(): Promise<void> {
    // Wait for pending writes
    await Promise.all(pendingWrites);

    if (fileHandle) {
      await fileHandle.end();
      fileHandle = null;
    }
  }

  return { log, getProcessLogs, truncateProcessLogs, close };
}
