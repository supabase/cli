import { Effect, Option } from "effect";

import { SUGGEST_LINKED_PROJECT } from "../connect-errors.ts";
import { TargetPasswordConflictError } from "./target.errors.ts";

/** Fails when a non-empty `--password` accompanies a target that is not a linked project. */
export const rejectTargetPassword = (
  target: "local" | "db-url",
  password: Option.Option<string>,
  linkedCheckout = false,
): Effect.Effect<void, TargetPasswordConflictError> =>
  Option.isNone(Option.filter(password, (value) => value.length > 0))
    ? Effect.void
    : Effect.fail(
        new TargetPasswordConflictError({
          target,
          message:
            target === "db-url"
              ? "--password can't be used with --db-url. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres"
              : `--password only applies to a linked project. The local database uses [db].password from supabase/config.toml.${linkedCheckout ? ` ${SUGGEST_LINKED_PROJECT}` : ""}`,
        }),
      );
