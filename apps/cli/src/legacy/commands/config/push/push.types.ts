/**
 * Outcome of pushing a single service's config to the linked project.
 *
 * `service` uses dotted keys mirroring `config.toml` paths (`api`,
 * `db.settings`, `db.network_restrictions`, `db.ssl_enforcement`, `auth`,
 * `storage`, `experimental.webhooks`). Status:
 *   - `updated`     — a diff existed, the user kept it, the PATCH/PUT/POST ran.
 *   - `up_to_date`  — remote already matched local (no diff, no write).
 *   - `skipped`     — a diff existed but the user declined the prompt.
 *   - `disabled`    — the service's local gate was off, so it was not touched.
 *
 * Go has no machine output for `config push`; this shape backs the TS
 * `json` / `stream-json` modes only.
 */
type LegacyConfigPushServiceStatus = "updated" | "up_to_date" | "skipped" | "disabled";

export interface LegacyConfigPushServiceResult {
  readonly service: string;
  readonly status: LegacyConfigPushServiceStatus;
}
