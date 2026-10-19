import { Predicate } from "effect";

import { BRANCH_PROJECT_REF_PATTERN } from "../ref-patterns.ts";
import { DB_URL_PATTERN, LINKED_LITERAL, OFF_LITERAL } from "./remote-vocabulary.ts";

/** What `--remote` (or a `db diff --from/--to` value) names. */
export type RemoteValue =
  | { readonly _tag: "Linked" }
  | { readonly _tag: "Ref"; readonly ref: string }
  | { readonly _tag: "DbUrl"; readonly url: string }
  | { readonly _tag: "Branch"; readonly name: string };

/** Whether a value is a `RemoteValue`, told apart by its `_tag`. */
export const isRemoteValue = (value: unknown): value is RemoteValue =>
  Predicate.isTagged(value, "Linked") ||
  Predicate.isTagged(value, "Ref") ||
  Predicate.isTagged(value, "DbUrl") ||
  Predicate.isTagged(value, "Branch");

export type NamedRemoteValue = Exclude<RemoteValue, { readonly _tag: "Linked" }>;

/** Starts every failure for an off or empty `--remote` value, which the CLI prints without its usual `Invalid value` framing. */
export const LEAVE_OUT_REMOTE_PREFIX = "Leave out --remote ";

/** 20 lowercase letters is a project ref, a postgres URL is a database, anything else names a branch. */
export const classifyNamedRemote = (raw: string): NamedRemoteValue => {
  if (BRANCH_PROJECT_REF_PATTERN.test(raw)) return { _tag: "Ref", ref: raw };
  if (DB_URL_PATTERN.test(raw)) return { _tag: "DbUrl", url: raw };
  return { _tag: "Branch", name: raw };
};

/** Classifies a `--remote` value; `undefined` for an empty value or an off switch (`false|no|off|0`). */
export const classifyRemoteValue = (raw: string): RemoteValue | undefined => {
  if (LINKED_LITERAL.test(raw)) return { _tag: "Linked" };
  if (raw === "" || OFF_LITERAL.test(raw)) return undefined;
  return classifyNamedRemote(raw);
};
