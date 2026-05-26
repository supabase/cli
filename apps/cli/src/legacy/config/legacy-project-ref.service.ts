import type { Effect, Option } from "effect";
import { Context } from "effect";

import type {
  LegacyInvalidProjectRefError,
  LegacyProjectNotLinkedError,
} from "./legacy-project-ref.errors.ts";

interface LegacyProjectRefResolverShape {
  readonly resolve: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<string, LegacyProjectNotLinkedError | LegacyInvalidProjectRefError, never>;
}

export class LegacyProjectRefResolver extends Context.Service<
  LegacyProjectRefResolver,
  LegacyProjectRefResolverShape
>()("supabase/legacy/ProjectRefResolver") {}

export const PROJECT_REF_PATTERN = /^[a-z]{20}$/;

export const PROJECT_NOT_LINKED_MESSAGE = "Cannot find project ref. Have you run `supabase link`?";

export const INVALID_PROJECT_REF_MESSAGE =
  "Invalid project ref format. Must be like `abcdefghijklmnopqrst`.";
