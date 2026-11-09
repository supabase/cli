import { DateTime, Option } from "effect";

export type SinceBound =
  | { readonly kind: "time"; readonly iso: string }
  | { readonly kind: "start" };

const durationShape = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/u;
const durationPart = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gu;
const unitMillis: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const isoDate = /^\d{4}-\d{2}-\d{2}/u;

export const parseSince = (value: string, nowMillis: number): SinceBound | undefined => {
  if (value === "start") return { kind: "start" };
  if (durationShape.test(value)) {
    let millis = 0;
    for (const [, amount, unit] of value.matchAll(durationPart))
      millis += Number(amount) * (unitMillis[unit ?? ""] ?? 0);
    return Option.match(DateTime.make(nowMillis - millis), {
      onNone: () => undefined,
      onSome: (time) => ({ kind: "time", iso: DateTime.formatIso(time) }),
    });
  }
  if (!isoDate.test(value)) return undefined;
  return Option.match(DateTime.make(value), {
    onNone: () => undefined,
    onSome: (time) => ({ kind: "time", iso: DateTime.formatIso(time) }),
  });
};
