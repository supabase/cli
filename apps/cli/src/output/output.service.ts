import type { Effect } from "effect";
import { ServiceMap } from "effect";

import type { NonInteractiveError } from "./errors.ts";
import type { OutputFormat, StreamEvent } from "./types.ts";

/**
 * Output - User-facing CLI output boundary.
 *
 * This service abstracts prompts, logging, progress reporting, and structured
 * result/error emission so commands can stay agnostic to the active output mode.
 */
interface OutputShape {
  readonly format: OutputFormat;
  readonly interactive: boolean;
  readonly intro: (title: string) => Effect.Effect<void>;
  readonly outro: (message: string) => Effect.Effect<void>;
  readonly info: (message: string) => Effect.Effect<void>;
  readonly warn: (message: string) => Effect.Effect<void>;
  readonly error: (message: string) => Effect.Effect<void>;
  readonly event: (event: StreamEvent) => Effect.Effect<void>;
  readonly promptText: (
    message: string,
    opts?: { validate?: (v: string) => string | undefined; defaultValue?: string },
  ) => Effect.Effect<string, NonInteractiveError>;
  readonly promptPassword: (message: string) => Effect.Effect<string, NonInteractiveError>;
  readonly promptConfirm: (message: string) => Effect.Effect<boolean, NonInteractiveError>;
  readonly progress: (opts: { max: number }) => Effect.Effect<{
    readonly start: (msg: string) => Effect.Effect<void>;
    readonly advance: (step: number, msg?: string) => Effect.Effect<void>;
    readonly message: (msg: string) => Effect.Effect<void>;
    readonly stop: (msg: string) => Effect.Effect<void>;
  }>;
  readonly success: (message: string, data?: Record<string, unknown>) => Effect.Effect<void>;
  readonly fail: (err: {
    readonly code: string;
    readonly message: string;
    readonly detail?: string;
    readonly suggestion?: string;
  }) => Effect.Effect<void>;
}

/**
 * Output - Service tag for CLI output and prompt behavior.
 */
export class Output extends ServiceMap.Service<Output, OutputShape>()(
  "@supabase/cli/output/Output",
) {}
