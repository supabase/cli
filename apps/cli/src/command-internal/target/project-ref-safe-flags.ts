import { Option } from "effect";

import { PROJECT_REF_PATTERN } from "../../config/project-ref.service.ts";

const isRefShaped = (value: Option.Option<string> | undefined): boolean =>
  value !== undefined && Option.isSome(value) && PROJECT_REF_PATTERN.test(value.value);

/** `--project-ref` and `--project-id` can also hold a branch name, so only a ref-shaped value is safe to log. */
export const projectRefSafeFlags = (flags: {
  readonly projectRef: Option.Option<string>;
  readonly projectId?: Option.Option<string>;
}): ReadonlyArray<string> => [
  ...(isRefShaped(flags.projectRef) ? ["project-ref"] : []),
  ...(isRefShaped(flags.projectId) ? ["project-id"] : []),
];
