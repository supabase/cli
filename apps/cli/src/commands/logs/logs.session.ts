import type { Effect, Option, Schema } from "effect";
import type { TargetFlagValues } from "../../command-internal/target/target-flags.ts";
import type { LogsBrowserWindow } from "./logs.browser.format.ts";

export interface LogsFlags extends TargetFlagValues {
  readonly stack: Option.Option<string>;
  readonly stackId: Option.Option<string>;
  readonly service: ReadonlyArray<string>;
  readonly resource: Option.Option<string>;
  readonly kind: Option.Option<"app" | "requests" | "builds">;
  readonly level: ReadonlyArray<string>;
  readonly search: Option.Option<string>;
  readonly since: Option.Option<string>;
  readonly from: Option.Option<string>;
  readonly to: Option.Option<string>;
  readonly sql: Option.Option<string>;
  readonly file: Option.Option<string>;
  readonly limit: number;
}

export interface LogsProgress {
  readonly message: string;
  readonly window?: LogsBrowserWindow;
}

export interface LogsSession<E = never> {
  readonly context?: string;
  readonly mode: "append" | "replace";
  readonly load: (
    end: number,
    emit: (row: Schema.JsonObject) => Effect.Effect<void>,
    progress?: (update: LogsProgress) => Effect.Effect<void>,
  ) => Effect.Effect<LogsBrowserWindow, E>;
}
