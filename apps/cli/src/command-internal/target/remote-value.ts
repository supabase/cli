import { Predicate, Result } from "effect";

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

/** A value with `://` that is not a postgres URL; `ref` is the project it points at when it is a project's own URL. */
export interface ForeignUrlRejection {
  readonly _tag: "ForeignUrl";
  readonly ref: string | undefined;
}

export type RemoteValueRejection =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Off" }
  | ForeignUrlRejection;

const PROJECT_URL_REF = /^[a-z][a-z0-9+.-]*:\/\/([a-z]{20})\.supabase\.[a-z]+(?::\d+)?(?:[/?#]|$)/;

const refOfProjectUrl = (value: string): string | undefined =>
  PROJECT_URL_REF.exec(value.toLowerCase())?.[1];

/** 20 lowercase letters is a project ref, a postgres URL is a database, any other URL is rejected, anything else names a branch. */
export const parseNamedRemote = (
  raw: string,
): Result.Result<NamedRemoteValue, ForeignUrlRejection> => {
  const value = raw.trim();
  if (BRANCH_PROJECT_REF_PATTERN.test(value)) return Result.succeed({ _tag: "Ref", ref: value });
  if (DB_URL_PATTERN.test(value)) return Result.succeed({ _tag: "DbUrl", url: value });
  if (value.includes("://")) {
    return Result.fail({ _tag: "ForeignUrl", ref: refOfProjectUrl(value) });
  }
  return Result.succeed({ _tag: "Branch", name: value });
};

/** Classifies a `--remote` value, or says why it is rejected: empty, an off switch (`false|no|off|0`) or a URL that is not a postgres URL. */
export const parseRemoteValue = (raw: string): Result.Result<RemoteValue, RemoteValueRejection> => {
  const value = raw.trim();
  if (LINKED_LITERAL.test(value)) return Result.succeed({ _tag: "Linked" });
  if (value === "") return Result.fail({ _tag: "Empty" });
  if (OFF_LITERAL.test(value)) return Result.fail({ _tag: "Off" });
  return parseNamedRemote(value);
};

/** {@link parseNamedRemote} for a caller that reads a value the flag's own parser already accepted: a foreign URL falls back to a branch name. */
export const classifyNamedRemote = (raw: string): NamedRemoteValue =>
  Result.getOrElse(parseNamedRemote(raw), (): NamedRemoteValue => ({
    _tag: "Branch",
    name: raw.trim(),
  }));

/** {@link parseRemoteValue} for the same caller; `undefined` for an empty value or an off switch. */
export const classifyRemoteValue = (raw: string): RemoteValue | undefined => {
  const value = raw.trim();
  if (value === "" || OFF_LITERAL.test(value)) return undefined;
  return Result.getOrUndefined(parseRemoteValue(value)) ?? classifyNamedRemote(value);
};
