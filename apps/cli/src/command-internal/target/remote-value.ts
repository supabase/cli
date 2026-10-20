import { Result } from "effect";

import { BRANCH_PROJECT_REF_PATTERN } from "../ref-patterns.ts";
import {
  DB_URL_PATTERN,
  KEYWORD_DSN_PATTERN,
  LINKED_LITERAL,
  OFF_LITERAL,
} from "./remote-vocabulary.ts";

/** What `--remote` (or a `db diff --from/--to` value) names. */
export type RemoteValue =
  | { readonly _tag: "Linked" }
  | { readonly _tag: "Ref"; readonly ref: string }
  | { readonly _tag: "DbUrl"; readonly url: string }
  | { readonly _tag: "Branch"; readonly name: string };

export type NamedRemoteValue = Exclude<RemoteValue, { readonly _tag: "Linked" }>;

/** A `://` value that is not a postgres URL; `ref` is set when it is a project's own URL. */
interface ForeignUrlRejection {
  readonly _tag: "ForeignUrl";
  readonly ref: string | undefined;
}

/** A `host=… user=…` connection string, which `--remote` does not read as a branch name. */
interface KeywordDsnRejection {
  readonly _tag: "KeywordDsn";
}

export type NamedRemoteRejection = ForeignUrlRejection | KeywordDsnRejection;

export type RemoteValueRejection =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Off" }
  | NamedRemoteRejection;

const PROJECT_URL_REF = /^[a-z][a-z0-9+.-]*:\/\/([a-z]{20})\.supabase\.[a-z]+(?::\d+)?(?:[/?#]|$)/;

const refOfProjectUrl = (value: string): string | undefined =>
  PROJECT_URL_REF.exec(value.toLowerCase())?.[1];

/** A project ref, a postgres URL or a branch name; any other URL or keyword string is rejected. */
export const parseNamedRemote = (
  raw: string,
): Result.Result<NamedRemoteValue, NamedRemoteRejection> => {
  const value = raw.trim();
  if (BRANCH_PROJECT_REF_PATTERN.test(value)) return Result.succeed({ _tag: "Ref", ref: value });
  if (DB_URL_PATTERN.test(value)) {
    return Result.succeed({
      _tag: "DbUrl",
      url: value.replace(DB_URL_PATTERN, (scheme) => scheme.toLowerCase()),
    });
  }
  if (value.includes("://")) {
    return Result.fail({ _tag: "ForeignUrl", ref: refOfProjectUrl(value) });
  }
  if (KEYWORD_DSN_PATTERN.test(value)) return Result.fail({ _tag: "KeywordDsn" });
  return Result.succeed({ _tag: "Branch", name: value });
};

/** Classifies a `--remote` value, or why it is rejected: empty, off, a foreign URL or a DSN. */
export const parseRemoteValue = (raw: string): Result.Result<RemoteValue, RemoteValueRejection> => {
  const value = raw.trim();
  if (LINKED_LITERAL.test(value)) return Result.succeed({ _tag: "Linked" });
  if (value === "") return Result.fail({ _tag: "Empty" });
  if (OFF_LITERAL.test(value)) return Result.fail({ _tag: "Off" });
  return parseNamedRemote(value);
};

/** {@link parseNamedRemote} for an accepted flag value; a rejection reads as a branch. */
const classifyNamedRemote = (raw: string): NamedRemoteValue =>
  Result.getOrElse(parseNamedRemote(raw), (): NamedRemoteValue => ({
    _tag: "Branch",
    name: raw.trim(),
  }));

/** {@link parseRemoteValue} for the same caller; `undefined` for an empty or off value. */
export const classifyRemoteValue = (raw: string): RemoteValue | undefined => {
  const value = raw.trim();
  if (value === "" || OFF_LITERAL.test(value)) return undefined;
  return Result.getOrUndefined(parseRemoteValue(value)) ?? classifyNamedRemote(value);
};
