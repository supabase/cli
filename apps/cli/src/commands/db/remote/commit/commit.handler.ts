import { Effect, Option } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { dbPull } from "../../pull/pull.handler.ts";
import type { DbPullFlags } from "../../pull/pull.command.ts";
import type { DbRemoteCommitFlags } from "./commit.command.ts";

/** Cobra's former `Deprecated` line on Go `db remote commit`. */
const REMOTE_COMMIT_DEPRECATION = 'Command "commit" is deprecated, use "db pull" instead.\n';

/** `db remote commit` is `db pull` with a fixed name and no PostRun line. */
export const remoteCommitToPullFlags = (flags: DbRemoteCommitFlags): DbPullFlags => ({
  name: Option.some("remote_commit"),
  declarative: Option.none(),
  usePgDelta: Option.none(),
  diffEngine: Option.none(),
  strictCoverage: false,
  schema: flags.schema,
  dbUrl: flags.dbUrl,
  linked: flags.linked ? Option.some(true) : Option.none(),
  local: Option.none(),
  projectRef: Option.none(),
  password: flags.password,
});

export const dbRemoteCommit = Effect.fn("db.remote.commit")(function* (flags: DbRemoteCommitFlags) {
  const output = yield* Output;
  yield* output.raw(REMOTE_COMMIT_DEPRECATION, "stderr");
  yield* dbPull(remoteCommitToPullFlags(flags), { skipFinishedLine: true });
});
