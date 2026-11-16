import { DateTime, Option } from "effect";
import type { StackLogRecord } from "@supabase/stack/effect";
import {
  aqua,
  blue,
  type ColorStream,
  dim,
  green,
  magenta,
  yellow,
} from "../../../../command-internal/colors.ts";
import { stripControlSequences } from "../../../../shared/output/strip-control-sequences.ts";
import type { LogWindow } from "../../../../command-internal/logs/local-history.ts";
import { markerText } from "../../../../command-internal/stack-log-events.ts";

const isLine = (record: StackLogRecord) => record.kind === "stdout" || record.kind === "stderr";

const palette = [aqua, yellow, green, magenta, blue];
const pad = (value: number, width: number) => String(value).padStart(width, "0");

const localTime = (iso: string) =>
  Option.match(DateTime.make(iso), {
    onNone: () => iso,
    onSome: (time) => {
      const parts = DateTime.toParts(DateTime.setZone(time, DateTime.zoneMakeLocal()));
      return `${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}.${pad(parts.millisecond, 3)}`;
    },
  });

export const makeTextFormatter = (
  instances: ReadonlyArray<{ readonly id: string; readonly service: string }>,
  stream: ColorStream,
) => {
  const kinds = new Map<string, number>();
  for (const { service } of instances) kinds.set(service, (kinds.get(service) ?? 0) + 1);
  const labels = new Map(
    instances.map(({ id, service }, index) => {
      const text = (kinds.get(service) ?? 0) > 1 ? `${service}:${id.slice(0, 8)}` : service;
      return [id, { text, paint: palette[index % palette.length] ?? aqua }] as const;
    }),
  );
  const width = Math.max(0, ...[...labels.values()].map(({ text }) => text.length));
  return (record: StackLogRecord): string => {
    const label = labels.get(record.instanceId) ?? { text: record.service, paint: aqua };
    const prefix = `${label.paint(label.text.padEnd(width), stream)} | `;
    const time = localTime(record.timestamp);
    return isLine(record)
      ? `${prefix}${time} ${stripControlSequences(record.text ?? "")}\n`
      : `${prefix}${dim(`${time} ${markerText(record)}`, stream)}\n`;
  };
};

export const truncationFooter = (window: LogWindow) =>
  `showing last ${window.shown.toLocaleString("en-US")} of ${window.total.toLocaleString("en-US")} lines, use --tail/--since`;
