import { Effect } from "effect";

import { announceTarget } from "../../src/shared/output/command-target.service.ts";

/**
 * Account commands resolve no target, but the `describeHostedConsent` matrix expects a `Target:`
 * banner under `--yes`; this announces a stand-in so those leaves can run the matrix.
 */
export const withAccountTargetBanner = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  announceTarget({ text: "account", json: { kind: "account" } }).pipe(Effect.andThen(run));
