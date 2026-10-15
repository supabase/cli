/**
 * Flag-presence helpers for the `--db-url / --linked / --local` target selection shared by
 * `db lint`, `db advisors`, and `test db`.
 *
 * Parsed flags carry no "was this explicitly set" bit, so presence is re-derived from raw argv,
 * skipping the value token of space-form value flags (`--schema --linked` does not set `--linked`).
 */

import { Effect, Option } from "effect";

import {
  VALUE_CONSUMING_LONG_FLAGS,
  VALUE_CONSUMING_SHORT_FLAGS,
} from "../shared/cli/value-consuming-flags.ts";
import { DbPasswordFlagsError } from "./db-config.errors.ts";

/** @public */
export { VALUE_CONSUMING_LONG_FLAGS, VALUE_CONSUMING_SHORT_FLAGS };

export type DbConnType = "db-url" | "linked" | "local";

export interface DbTargetSelection {
  /** Explicitly-set selector flags, alphabetically sorted. */
  readonly setFlags: ReadonlyArray<string>;
  /** db-url > local > linked; `undefined` when no selector was set (callers default to local). */
  readonly connType: DbConnType | undefined;
}

/**
 * Which of `--linked` / `--local` were explicitly set (including `--no-` forms), sorted, for the
 * mutually-exclusive-flag error of `seed buckets` and `storage ls/cp/mv/rm`.
 */
export function changedLinkedLocalFlags(args: ReadonlyArray<string>): ReadonlyArray<string> {
  let linked = false;
  let local = false;
  let skipNext = false;

  for (const token of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "--") break;

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const name = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
      const isBare = eqIdx === -1;
      if (name === "linked" || name === "no-linked") {
        linked = true;
        continue;
      }
      if (name === "local" || name === "no-local") {
        local = true;
        continue;
      }
      if (isBare && VALUE_CONSUMING_LONG_FLAGS.has(name)) skipNext = true;
      continue;
    }

    if (token.startsWith("-") && token.length >= 2 && token.charAt(1) !== "-") {
      if (token.length === 2 && VALUE_CONSUMING_SHORT_FLAGS.has(token.charAt(1))) {
        skipNext = true;
      }
    }
  }

  const setFlags: Array<string> = [];
  if (linked) setFlags.push("linked");
  if (local) setFlags.push("local");
  return setFlags;
}

/** Resolves the DB target selection from raw args; `setFlags` is sorted so conflict text is stable. */
export function resolveDbTargetFlags(args: ReadonlyArray<string>): DbTargetSelection {
  let dbUrlChanged = false;
  let linkedChanged = false;
  let localChanged = false;

  let skipNext = false;
  for (const token of args) {
    // A pending value is consumed even when it is "--".
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (token === "--") break;

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const name = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
      const isBare = eqIdx === -1;

      if (name === "db-url") {
        dbUrlChanged = true;
        if (isBare) skipNext = true;
        continue;
      }
      if (name === "linked" || name === "no-linked") {
        linkedChanged = true;
        continue;
      }
      if (name === "local" || name === "no-local") {
        localChanged = true;
        continue;
      }

      if (isBare && VALUE_CONSUMING_LONG_FLAGS.has(name)) {
        skipNext = true;
      }
      continue;
    }

    if (token.startsWith("-") && token.length >= 2 && token.charAt(1) !== "-") {
      const shortName = token.charAt(1);
      // `-svalue` carries its value attached; only bare `-s` skips the next token.
      if (token.length === 2 && VALUE_CONSUMING_SHORT_FLAGS.has(shortName)) {
        skipNext = true;
      }
    }
  }

  const setFlags: Array<string> = [];
  if (dbUrlChanged) setFlags.push("db-url");
  if (linkedChanged) setFlags.push("linked");
  if (localChanged) setFlags.push("local");

  let connType: DbConnType | undefined;
  if (dbUrlChanged) {
    connType = "db-url";
  } else if (localChanged) {
    connType = "local";
  } else if (linkedChanged) {
    connType = "linked";
  }

  return { setFlags, connType };
}

/**
 * `--password` only authenticates against a linked project, so it fails when paired with a target
 * that carries its own credentials (`--db-url`) or reads them from config (`--local`, also the
 * default when no selector is set). `localByDefaultFor` names the command whose unset selector
 * fell back to local, so the message can point at `--linked` instead of a `--local` the user never typed.
 */
export const rejectPasswordWithDirectTarget = (
  connType: DbConnType | undefined,
  password: Option.Option<string> | undefined,
  options: { readonly localByDefaultFor?: string } = {},
): Effect.Effect<void, DbPasswordFlagsError> => {
  if (
    password === undefined ||
    Option.isNone(Option.filter(password, (value) => value.length > 0)) ||
    connType === "linked"
  ) {
    return Effect.void;
  }
  const target = connType ?? "local";
  const message =
    target === "db-url"
      ? "--password can't be used with --db-url. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres"
      : options.localByDefaultFor !== undefined
        ? `${options.localByDefaultFor} targets the local database unless you pass --linked, and --password only applies to a linked project. Pass --linked, or drop --password.`
        : "--password can't be used with --local. The local database uses [db].password from supabase/config.toml.";
  return Effect.fail(new DbPasswordFlagsError({ message }));
};
