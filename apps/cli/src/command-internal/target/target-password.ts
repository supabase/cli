import { Effect, Option } from "effect";

import { configKey } from "../config-advice.ts";
import { findConfigFileRef } from "../config-file-ref.ts";

import { SUGGEST_LINKED_PROJECT } from "../connect-errors.ts";
import { TargetPasswordConflictError } from "./target.errors.ts";

/** Fails when a non-empty `--password` accompanies a target that is not a linked project. */
export const rejectTargetPassword = Effect.fnUntraced(function* (
  target: "local" | "db-url",
  password: Option.Option<string>,
  linkedCheckout: boolean,
  workdir: string,
) {
  if (Option.isNone(Option.filter(password, (value) => value.length > 0))) return;
  const configFile = target === "db-url" ? undefined : yield* findConfigFileRef(workdir);
  return yield* new TargetPasswordConflictError({
    target,
    message:
      configFile === undefined
        ? "--password can't be used with --remote=<db-url>. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres"
        : `--password only applies to a linked project. The local database uses ${configKey(configFile.format, "db", "password")} from ${configFile.path}.${linkedCheckout ? ` ${SUGGEST_LINKED_PROJECT}` : ""}`,
  });
});
