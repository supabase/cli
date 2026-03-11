import { Cause, Option } from "effect";

type NormalizedCliError = {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
};

type ErrorRecord = Record<string, unknown>;

const isErrorRecord = (value: unknown): value is ErrorRecord =>
  typeof value === "object" && value !== null;

const readString = (value: ErrorRecord, key: string): string | undefined => {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
};

const mappedError = (error: ErrorRecord): NormalizedCliError | undefined => {
  const tag = readString(error, "_tag");
  switch (tag) {
    case "NoRunningStackError":
      return {
        code: tag,
        message: "No local Supabase stack is running for this project.",
        detail: "The CLI could not find a running stack for the current working directory.",
        suggestion:
          "Run `supabase start` in this project, or change into a directory with a running stack.",
      };
    case "StateNotFoundError": {
      const name = readString(error, "name");
      return {
        code: tag,
        message: "The requested local Supabase stack was not found.",
        ...(name ? { detail: `Missing stack state: ${name}.` } : {}),
        suggestion: "Run `supabase start` to create a new local stack.",
      };
    }
    case "DaemonStillRunningError": {
      const name = readString(error, "name");
      return {
        code: tag,
        message: "The local Supabase stack did not stop cleanly.",
        ...(name ? { detail: `Stack "${name}" is still running.` } : {}),
        suggestion: "Wait a moment and try `supabase stop` again.",
      };
    }
    case "StackAlreadyRunningError":
      return {
        code: tag,
        message:
          readString(error, "name") && typeof error.pid === "number"
            ? `A Supabase stack "${readString(error, "name")}" is already running (PID ${error.pid}).`
            : "A local Supabase stack is already running.",
        suggestion: "Use `supabase stop` before starting another stack for this project.",
      };
    case "DaemonStartError":
      return {
        code: tag,
        message: readString(error, "message") ?? "Failed to start the Supabase daemon.",
        suggestion: "Check local resources and try `supabase start` again.",
      };
  }
};

export function normalizeCliError(error: unknown): NormalizedCliError {
  if (isErrorRecord(error)) {
    const mapped = mappedError(error);
    if (mapped) {
      return mapped;
    }

    const code = readString(error, "_tag") ?? "UnknownError";
    const message = readString(error, "message") ?? readString(error, "detail") ?? code;
    const detail = readString(error, "detail");
    const suggestion = readString(error, "suggestion");
    return {
      code,
      message,
      ...(detail && detail !== message ? { detail } : {}),
      ...(suggestion ? { suggestion } : {}),
    };
  }

  if (error instanceof Error) {
    return {
      code: error.name || "Error",
      message: error.message || "Unknown error",
    };
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return {
      code: "UnknownError",
      message: error.trim(),
    };
  }

  return {
    code: "UnknownError",
    message: "Unknown error",
  };
}

export function normalizeCause(cause: Cause.Cause<unknown>): NormalizedCliError {
  const errorOption = Cause.findErrorOption(cause);
  return normalizeCliError(Option.getOrElse(errorOption, () => Cause.squash(cause)));
}

export function formatCliError(error: NormalizedCliError): string {
  const lines = [error.message];
  if (error.detail && error.detail !== error.message) {
    lines.push(`Detail: ${error.detail}`);
  }
  if (error.suggestion) {
    lines.push(`Suggestion: ${error.suggestion}`);
  }
  return lines.join("\n");
}
