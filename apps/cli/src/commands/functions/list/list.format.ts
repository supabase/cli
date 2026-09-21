import { DateTime, Option } from "effect";

import { renderGlamourTable } from "../../../output/glamour-table.ts";
import type { Functions } from "./list.encoders.ts";

const pad2 = (value: number): string => value.toString().padStart(2, "0");

export function formatUnixMilliTimestamp(value: number): string {
  return DateTime.make(value).pipe(
    Option.map((dateTime) => {
      const utc = DateTime.toPartsUtc(dateTime);
      return `${pad2(utc.year)}-${pad2(utc.month)}-${pad2(utc.day)} ${pad2(utc.hour)}:${pad2(utc.minute)}:${pad2(utc.second)}`;
    }),
    Option.getOrElse(() => "NaN-NaN-NaN NaN:NaN:NaN"),
  );
}

export function renderFunctionsTable(functions: Functions): string {
  return renderGlamourTable(
    ["ID", "NAME", "SLUG", "STATUS", "VERSION", "UPDATED_AT (UTC)"],
    functions.map((fn) => [
      fn.id,
      fn.name,
      fn.slug,
      fn.status,
      String(fn.version),
      formatUnixMilliTimestamp(fn.updated_at),
    ]),
  );
}
