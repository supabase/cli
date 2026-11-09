import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { logsWindow } from "./logs.format.ts";

it.effect("anchors the default hour to an explicit historical end", () =>
  logsWindow(
    { since: Option.none(), to: Option.some("2025-01-01T12:00:00Z") },
    Date.parse("2026-01-01T00:00:00Z"),
  ).pipe(
    Effect.tap((window) =>
      Effect.sync(() =>
        expect(window).toEqual({
          start: "2025-01-01T11:00:00.000Z",
          end: "2025-01-01T12:00:00.000Z",
        }),
      ),
    ),
  ),
);
