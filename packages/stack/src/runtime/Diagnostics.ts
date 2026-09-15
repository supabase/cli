import { redactKnownSecrets } from "../state/SecretStore.ts";

const DIAGNOSTIC_TAIL_LINES = 40;

const LEFTOVER_PERSISTENT_DATA =
  /exists but is not empty|directory not empty|not empty directory|PGDATA.*exist|initdb:.*exist|volume is in use|already exists.*volume/i;

/** Wipe guidance when a first-create retry cannot launch over leftover PGDATA/volume. */
export const LEFTOVER_PERSISTENT_DATA_GUIDANCE =
  "Leftover files from a failed first start remain. db reset --local or stack destroy wipes them.";

export const looksLikeLeftoverPersistentData = (message: string): boolean =>
  LEFTOVER_PERSISTENT_DATA.test(message);

export const withLeftoverPersistentDataGuidance = (message: string): string => {
  if (!looksLikeLeftoverPersistentData(message) || message.includes("db reset")) return message;
  return `${message}. ${LEFTOVER_PERSISTENT_DATA_GUIDANCE}`;
};

export const formatStopTimeoutMessage = (running: ReadonlyArray<string>): string => {
  const listed = running.length > 0 ? ` Still running: ${running.join(", ")}.` : "";
  return `Stop timed out after 60s.${listed} The owner stop continues in the background.`;
};

export interface ProcessOutputTail {
  readonly pushBytes: (stream: "stdout" | "stderr", bytes: Uint8Array) => void;
  readonly finish: (knownSecrets?: Iterable<string>) => string;
}

/** Bounded, secret-redacted last lines from a one-shot or dying native process. */
export const makeProcessOutputTail = (): ProcessOutputTail => {
  const lines: Array<string> = [];
  const accumulators = {
    stdout: { decoder: new TextDecoder(), remainder: "" },
    stderr: { decoder: new TextDecoder(), remainder: "" },
  };
  const pushLine = (line: string): void => {
    if (line.length === 0) return;
    lines.push(line);
    if (lines.length > DIAGNOSTIC_TAIL_LINES) lines.shift();
  };
  return {
    pushBytes: (stream, bytes) => {
      const accumulator = accumulators[stream];
      accumulator.remainder += accumulator.decoder.decode(bytes, { stream: true });
      const parts = accumulator.remainder.split(/\r?\n/);
      accumulator.remainder = parts.pop() ?? "";
      for (const line of parts) pushLine(`${stream}: ${line}`);
    },
    finish: (knownSecrets = []) => {
      for (const stream of ["stdout", "stderr"] as const) {
        const accumulator = accumulators[stream];
        accumulator.remainder += accumulator.decoder.decode();
        if (accumulator.remainder.length > 0) pushLine(`${stream}: ${accumulator.remainder}`);
        accumulator.remainder = "";
      }
      if (lines.length === 0) return "";
      return redactKnownSecrets(lines.join("\n"), knownSecrets);
    },
  };
};
