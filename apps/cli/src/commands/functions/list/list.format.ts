import { DateTime, Option } from "effect";

import { renderGlamourTable } from "../../../output/glamour-table.ts";
import type { Functions } from "./list.encoders.ts";

export function formatUnixMilliTimestamp(value: number): string {
  const parts = DateTime.make(value).pipe(
    Option.map((dateTime) => {
      const utc = DateTime.toPartsUtc(dateTime);
      return [utc.year, utc.month, utc.day, utc.hour, utc.minute, utc.second];
    }),
    Option.getOrElse(() => [NaN, NaN, NaN, NaN, NaN, NaN]),
  );
  const [year, ...rest] = parts.map((part) => part.toString().padStart(2, "0"));
  return `${year}-${rest[0]}-${rest[1]} ${rest[2]}:${rest[3]}:${rest[4]}`;
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
