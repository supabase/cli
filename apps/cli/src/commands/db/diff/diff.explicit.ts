import { Result } from "effect";

import { DbConfigIpv6Error } from "../../../command-internal/db-config.errors.ts";
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
import {
  joinFlags,
  type TargetDeprecation,
} from "../../../command-internal/target/target-selector.ts";
import {
  TargetEmptyValueError,
  TargetInvalidValueError,
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
  type TargetSelectorError,
} from "../../../command-internal/target/target.errors.ts";

/** What an explicit `--from`/`--to` value names. */
export type ExplicitRef =
  | { readonly _tag: "Local" }
  | { readonly _tag: "Migrations" }
  | { readonly _tag: "Remote"; readonly viaDeprecatedLinked: boolean }
  | NamedRemoteRejection
  | NamedRemoteValue;

/**
 * `local`, `migrations` and `remote` (`linked` is its deprecated spelling) are keywords; anything
 * else is classified like a `--remote` value, and a rejected value comes back as that rejection.
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

/** The warning per deprecated flag, naming its `--from`/`--to` replacement; no URL is echoed. */
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

const CONFLICT_REPLACEMENTS = {
  "--linked": "--from=remote or --to=remote instead of --linked",
  "--db-url": "--from=<url> or --to=<url> instead of --db-url",
  "--local": "drop --local",
} as const;

const isConflictFlag = (flag: string): flag is keyof typeof CONFLICT_REPLACEMENTS =>
  Object.hasOwn(CONFLICT_REPLACEMENTS, flag);

/** A selector error whose suggestion names `--from`/`--to`, as explicit mode rejects `--remote`. */
export const explicitSelectorError = (error: TargetSelectorError): TargetSelectorError => {
  switch (error._tag) {
    case "TargetEmptyValueError":
      return new TargetEmptyValueError({
        flag: error.flag,
        message: error.message,
        suggestion:
          error.flag === "--db-url"
            ? "Pass a postgresql:// URL as --from=<url> or --to=<url>."
            : "Pass a project ref as --from=<ref> or --to=<ref>.",
      });
    case "TargetInvalidValueError":
      return new TargetInvalidValueError({
        flag: error.flag,
        message: error.message,
        suggestion:
          error.ref === undefined
            ? "Pass a project ref as --from=<ref> or --to=<ref>."
            : `Use --from=${error.ref} or --to=${error.ref}.`,
        ref: error.ref,
      });
    case "TargetProjectRefConflictError":
      return new TargetProjectRefConflictError({
        conflictsWith: error.conflictsWith,
        message: error.message,
        suggestion:
          error.conflictsWith === "--db-url"
            ? "Use --from=<ref> or --to=<ref> instead of --project-ref, and --from=<url> or --to=<url> instead of --db-url."
            : "Use --from=<ref> or --to=<ref> instead of --project-ref, and drop --local.",
      });
    case "TargetSelectorConflictError": {
      if (!error.flags.every(isConflictFlag)) return error;
      const clauses = error.flags.map((flag) => CONFLICT_REPLACEMENTS[flag]);
      return new TargetSelectorConflictError({
        flags: error.flags,
        message: `Only one of --linked, --db-url and --local can be set; got ${joinFlags(error.flags)}.`,
        suggestion: `Use ${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}.`,
      });
    }
  }
};

/** An IPv6 failure for another project suggests `--from`/`--to`, as explicit mode rejects `--remote`. */
export const explicitIpv6Error = (error: DbConfigIpv6Error): DbConfigIpv6Error =>
  error.remedy === "pooler-url"
    ? new DbConfigIpv6Error({
        message: error.message,
        remedy: error.remedy,
        suggestion:
          "Pass the project's connection pooler URL as --from=<url> or --to=<url> to connect over IPv4.",
      })
    : error;
