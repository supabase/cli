import { Data } from "effect";

/**
 * `--use-orioledb` without `--experimental`. The next shell deliberately keeps
 * this friendlier wording; the legacy shell byte-matches Go's cobra
 * required-flag message instead (see
 * `legacy/commands/init/init.errors.ts`, CLI-1986).
 */
export class InitExperimentalRequiredError extends Data.TaggedError(
  "InitExperimentalRequiredError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  override get message() {
    return "The --use-orioledb flag requires --experimental.";
  }
}
