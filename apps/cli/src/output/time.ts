import { DateTime, Option } from "effect";

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Extracts the date portion of an ISO 8601 UTC string as `YYYY-MM-DD`. */
export function formatUtcDate(iso: string): string {
  return DateTime.make(iso).pipe(
    Option.map(DateTime.formatIsoDateUtc),
    Option.getOrElse(() => "Invalid date"),
  );
}

/** Extracts the time portion of an ISO 8601 UTC string as `HH:MM:SS UTC`. */
export function formatUtcTime(iso: string): string {
  return DateTime.make(iso).pipe(
    Option.map((dt) => {
      const { hour, minute, second } = DateTime.toPartsUtc(dt);
      return `${pad2(hour)}:${pad2(minute)}:${pad2(second)} UTC`;
    }),
    Option.getOrElse(() => "Invalid time"),
  );
}
