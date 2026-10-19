import { Result } from "effect";

import {
  classifyNamedRemote,
  parseNamedRemote,
  type NamedRemoteValue,
} from "../../../command-internal/target/remote-value.ts";

/** What an explicit `--from`/`--to` value names. */
export type ExplicitRef =
  | { readonly _tag: "Local" }
  | { readonly _tag: "Migrations" }
  | { readonly _tag: "Remote"; readonly viaDeprecatedLinked: boolean }
  | { readonly _tag: "KeywordDsn" }
  | NamedRemoteValue;

/**
 * `local`, `migrations` and `remote` (the linked project) are keywords; `linked` is the
 * deprecated spelling of `remote`. Anything else is classified like a `--remote` value, so a
 * branch that shares a keyword's name is reached by its ref or UUID. A keyword connection string
 * is kept apart so it is never echoed as a branch name.
 */
export function classifyExplicitRef(ref: string): ExplicitRef {
  switch (ref) {
    case "local":
      return { _tag: "Local" };
    case "migrations":
      return { _tag: "Migrations" };
    case "remote":
      return { _tag: "Remote", viaDeprecatedLinked: false };
    case "linked":
      return { _tag: "Remote", viaDeprecatedLinked: true };
    default: {
      const parsed = parseNamedRemote(ref);
      if (Result.isFailure(parsed) && parsed.failure._tag === "KeywordDsn") {
        return { _tag: "KeywordDsn" };
      }
      return classifyNamedRemote(ref);
    }
  }
}
