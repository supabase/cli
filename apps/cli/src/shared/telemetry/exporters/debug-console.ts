import type { Tracer } from "effect";

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const mil = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${mil}`;
}

export function formatSpanForDebugConsole(span: Tracer.Span): string | undefined {
  const status = span.status;
  if (status._tag !== "Ended") return undefined;

  const durationMs = Math.round(Number(status.endTime - status.startTime) / 1_000_000);
  const timestampMs = Number(status.startTime / BigInt(1_000_000));
  const time = formatTimestamp(timestampMs);

  const attrs: Record<string, unknown> = {};
  for (const [key, value] of span.attributes) {
    attrs[key] = value;
  }
  const attrStr = Object.keys(attrs).length > 0 ? ` ${JSON.stringify(attrs)}` : "";

  return `[${time}] ${span.name} (${durationMs}ms)${attrStr}\n`;
}

export function makeDebugConsoleExporter(
  write: (line: string) => void,
): (span: Tracer.Span) => void {
  return (span) => {
    const line = formatSpanForDebugConsole(span);
    if (line !== undefined) {
      write(line);
    }
  };
}
