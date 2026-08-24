import { renderGlamourTable } from "../../../output/legacy-glamour-table.ts";
import { DateTime } from "effect";
import type { Functions } from "./list.encoders.ts";

export function formatUnixMilliTimestamp(value: number): string {
  const iso = DateTime.formatIso(DateTime.makeUnsafe(value));
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19);
  return `${date} ${time}`;
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
