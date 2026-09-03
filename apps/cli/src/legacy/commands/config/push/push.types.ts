import type { LegacyPushResource } from "./push.plan.ts";

/**
 * Outcome of pushing a single service's config to the linked project.
 *
 * `service` and `status` keep their existing values (dotted keys mirroring
 * `config.toml` paths, plus the fixed `experimental.webhooks` identifier —
 * see `push.format.ts`'s doc comment for why `service` is an opaque
 * identifier, not itself a config path); `changes` is additive. Status:
 *   - `updated`      — a pushable difference existed, the user kept it, the write ran.
 *   - `up_to_date`   — no pushable difference existed for this resource.
 *   - `skipped`      — a pushable difference existed but the user declined the prompt.
 *   - `disabled`     — the service's local gate was off, so it was not touched.
 *   - `unavailable`  — the effective-config response omitted this resource's
 *     block, so there was nothing to compare against; nothing was written.
 *   - `not_pushable` — a pushable difference existed, but none of it could be
 *     encoded into a request body (every routed change ended up
 *     `unencodable`); nothing was written.
 *
 * There is no machine output for the previous per-service-subset `config
 * push`; this shape backs the TS `json` / `stream-json` modes only.
 */
type LegacyConfigPushServiceStatus =
  | "updated"
  | "up_to_date"
  | "skipped"
  | "disabled"
  | "unavailable"
  | "not_pushable";

export interface LegacyConfigPushServiceResult {
  readonly service: LegacyPushResource | "experimental.webhooks";
  readonly status: LegacyConfigPushServiceStatus;
  /** Change paths this service's write communicated (empty for `up_to_date`/`disabled`/
   *  `unavailable`/`not_pushable`; `skipped` carries what the declined write would have
   *  communicated, excluding secrets). */
  readonly changes: ReadonlyArray<ReadonlyArray<string>>;
}
