import { DateTime, Option, Schema } from "effect";

export type MachineFormat = "json" | "stream-json";

export const MachineOutput = Schema.Struct({
  exitCode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
});
export interface MachineOutput extends Schema.Schema.Type<typeof MachineOutput> {}

export const Baseline = Schema.Struct({
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  argv: Schema.Array(Schema.String),
  cases: Schema.Record(Schema.String, MachineOutput),
});

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export function normalizeStdout(format: MachineFormat, stdout: string) {
  if (!stdout.endsWith("\n")) throw new Error("stdout must end with a newline");
  const body = stdout.slice(0, -1);
  if (format === "json") {
    if (body.endsWith("\n")) throw new Error("stdout must end with a single newline");
    return parseJson(body);
  }
  return body.split("\n").map((line, index) => {
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
    return { ...event, timestamp: "<timestamp>" };
  });
}
