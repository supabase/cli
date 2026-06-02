import { Data } from "effect";

export class InitAlreadyExistsError extends Data.TaggedError("InitAlreadyExistsError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  override get message() {
    return "A Supabase project is already initialized in this directory.";
  }
}

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
