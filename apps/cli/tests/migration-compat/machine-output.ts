import { DateTime, Option, Schema } from "effect";

export type MachineFormat = "json" | "stream-json" | "yaml" | "toml";

export const MachineOutput = Schema.Struct({
  exitCode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
  requests: Schema.Array(Schema.String),
});
export interface MachineOutput extends Schema.Schema.Type<typeof MachineOutput> {}

export const Baseline = Schema.Struct({
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  argv: Schema.Array(Schema.String),
  cases: Schema.Record(Schema.String, MachineOutput),
});

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export function normalizeStdout(format: MachineFormat, stdout: string) {
  if (format === "yaml" || format === "toml") return stdout;
  if (!stdout.endsWith("\n")) throw new Error("stdout must end with a newline");
  const body = stdout.slice(0, -1);
  if (format === "json") {
    if (body !== body.trimEnd()) throw new Error("JSON must be followed immediately by one LF");
    parseJson(body);
    return stdout;
  }
  const lines = body.split("\n").map((line, index) => {
    const location = `stdout line ${index + 1}`;
    if (line.includes("\r")) throw new Error(`${location} must use LF framing`);
    const event = parseJson(line);
    if (typeof event !== "object" || event === null || !("timestamp" in event)) {
      throw new Error(`Missing event timestamp on ${location}`);
    }
    const { timestamp } = event;
    if (
      typeof timestamp !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
      Option.getOrUndefined(Option.map(DateTime.make(timestamp), DateTime.formatIso)) !== timestamp
    ) {
      throw new Error(`Expected a UTC ISO timestamp with milliseconds on ${location}`);
    }
    const literal = `"${timestamp}"`;
    const offset = line.indexOf(literal);
    if (offset < 0 || offset !== line.lastIndexOf(literal)) {
      throw new Error(`Cannot isolate the event timestamp on ${location}`);
    }
    return line.replace(literal, '"<timestamp>"');
  });
  return `${lines.join("\n")}\n`;
}
