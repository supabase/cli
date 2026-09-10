import type { PushResource } from "./push.plan.ts";

/**
 * Outcome of pushing a single service's config to the linked project.
 *
 * `service` is a dotted key mirroring `config.toml` paths, plus the fixed
 * `experimental.webhooks` identifier — see `push.format.ts`'s doc comment for why it's an opaque
 * identifier, not itself a config path. Status:
 *   - `updated`      — a pushable difference existed, the user kept it, the write ran.
 *   - `up_to_date`   — no pushable difference existed for this resource.
 *   - `skipped`      — a pushable difference existed but the user declined the prompt.
 *   - `disabled`     — the service's local gate was off, so it was not touched.
 *   - `unavailable`  — the effective-config response omitted this resource's
 *     block, so there was nothing to compare against; nothing was written.
 *   - `not_pushable` — a pushable difference existed, but none of it could be
 *     encoded into a request body (every routed change ended up
 *     `unencodable`); nothing was written.
 */
type ConfigPushServiceStatus =
  | "updated"
  | "up_to_date"
  | "skipped"
  | "disabled"
  | "unavailable"
  | "not_pushable";

export interface ConfigPushServiceResult {
  readonly service: PushResource | "experimental.webhooks";
  readonly status: ConfigPushServiceStatus;
  /** Change paths this service's write communicated (empty for `up_to_date`/`disabled`/
   *  `unavailable`/`not_pushable`; `skipped` carries what the declined write would have
   *  communicated, excluding secrets). For `experimental.webhooks` — which has no
   *  registry-comparable path of its own — `changes` is `[["experimental","webhooks","enabled"]]`
   *  once the enable POST ran, `[]` otherwise, so a webhook-only push is still counted as a
   *  pushed property in the json/stream-json summary. */
  readonly changes: ReadonlyArray<ReadonlyArray<string>>;
}
