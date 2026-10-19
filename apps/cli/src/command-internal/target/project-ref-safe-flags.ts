import { Option } from "effect";

import { PROJECT_REF_PATTERN } from "../../config/project-ref.service.ts";

/** `--project-ref` can also hold a branch name, so only a ref-shaped value is safe to log. */
export const projectRefSafeFlags = (projectRef: Option.Option<string>): ReadonlyArray<string> =>
  Option.isSome(projectRef) && PROJECT_REF_PATTERN.test(projectRef.value) ? ["project-ref"] : [];
