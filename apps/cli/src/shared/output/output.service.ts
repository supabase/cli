import type { Effect } from "effect";
import { Context } from "effect";

import type { NonInteractiveError } from "./errors.ts";
import type { OutputFormat, StreamEvent } from "./types.ts";

interface OutputTask {
  readonly message: (message: string) => Effect.Effect<void>;
  readonly succeed: (message?: string) => Effect.Effect<void>;
  readonly fail: (message?: string) => Effect.Effect<void>;
  readonly info: (message?: string) => Effect.Effect<void>;
  readonly cancel: (message?: string) => Effect.Effect<void>;
  readonly clear: () => Effect.Effect<void>;
}

interface OutputSelectOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

interface OutputSelectBehavior {
  readonly mode?: "auto" | "select" | "autocomplete";
  readonly autocompleteThreshold?: number;
  readonly placeholder?: string;
  readonly maxItems?: number;
}

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
  readonly task: (message: string) => Effect.Effect<OutputTask>;
  readonly promptText: (
    message: string,
    opts?: { validate?: (v: string) => string | undefined; defaultValue?: string },
  ) => Effect.Effect<string, NonInteractiveError>;
  readonly promptPassword: (message: string) => Effect.Effect<string, NonInteractiveError>;
  readonly promptConfirm: (message: string) => Effect.Effect<boolean, NonInteractiveError>;
  readonly promptSelect: (
    message: string,
    options: ReadonlyArray<OutputSelectOption>,
    behavior?: OutputSelectBehavior,
  ) => Effect.Effect<string, NonInteractiveError>;
  readonly promptMultiSelect: (
    message: string,
    options: ReadonlyArray<{
      readonly value: string;
      readonly label: string;
      readonly hint?: string;
    }>,
  ) => Effect.Effect<ReadonlyArray<string>, NonInteractiveError>;
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
  /**
   * Writes a raw chunk to stdout or stderr without framing.
   *
   * Reserved for byte-exact parity output (legacy Go-format encoders, Glamour-styled tables)
   * where structured framing would change the bytes on the wire. Routes through the active
   * output layer so tests can capture it without monkey-patching `process.stdout` / `process.stderr`.
   */
  readonly raw: (text: string, stream?: "stdout" | "stderr") => Effect.Effect<void>;
}

/**
 * Output - Service tag for CLI output and prompt behavior.
 */
export class Output extends Context.Service<Output, OutputShape>()("supabase/output/Output") {}
