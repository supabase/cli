import { Result } from "effect";

import {
  parseNamedRemote,
  type NamedRemoteRejection,
  type NamedRemoteValue,
  type RemoteValue,
} from "../../../command-internal/target/remote-value.ts";
import { DB_URL_PATTERN } from "../../../command-internal/target/remote-vocabulary.ts";
import {
  deprecationLead,
  LOCAL_NOT_NEEDED_MESSAGE,
} from "../../../command-internal/target/target-deprecation.ts";
import type { TargetDeprecation } from "../../../command-internal/target/target-selector.ts";

/** What an explicit `--from`/`--to` value names. */
export type ExplicitRef =
  | { readonly _tag: "Local" }
  | { readonly _tag: "Migrations" }
  | { readonly _tag: "Remote"; readonly viaDeprecatedLinked: boolean }
  | NamedRemoteRejection
  | NamedRemoteValue;

/**
 * `local`, `migrations` and `remote` (the linked project) are keywords and `linked` is the deprecated spelling of `remote`;
 * anything else is classified like a `--remote` value, so a branch sharing a keyword's name is reached by its ref or UUID.
 * A value `--remote` rejects is returned as that rejection, never as a branch name, so it is not echoed.
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
      return Result.isFailure(parsed) ? parsed.failure : parsed.success;
    }
  }
}

const replacementOf = (remote: RemoteValue): string => {
  switch (remote._tag) {
    case "Linked":
      return "--from=remote or --to=remote";
    case "Ref":
      return "--from=<ref> or --to=<ref>";
    case "Branch":
      return "--from=<branch> or --to=<branch>";
    case "DbUrl":
      return "--from=<url> or --to=<url>";
  }
};

/** The warning for each deprecated selector flag an explicit run used, naming the `--from`/`--to` value that replaces it; a database URL is never echoed. */
export const explicitDeprecationMessages = (
  deprecations: ReadonlyArray<TargetDeprecation>,
): ReadonlyArray<string> =>
  deprecations.map((deprecation) => {
    if (deprecation.kind === "local") return LOCAL_NOT_NEEDED_MESSAGE;
    const { flags, remote } = deprecation;
    const lead = deprecationLead(flags);
    if (remote._tag === "Branch" && classifyExplicitRef(remote.name)._tag !== "Branch") {
      return `${lead} Reach a branch named "${remote.name}" with --from=<its ref or UUID> or --to=<its ref or UUID> instead`;
    }
    if (remote._tag === "DbUrl" && !DB_URL_PATTERN.test(remote.url)) {
      return `${lead} Convert the connection string to a postgresql:// URL and pass it as --from=<url> or --to=<url> instead`;
    }
    return `${lead} Use ${replacementOf(remote)} instead`;
  });
