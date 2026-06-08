import type { ProjectConfig } from "@supabase/config";

/**
 * Push-subset of Go's `experimental` config (`pkg/config/updater.go`
 * `UpdateExperimentalConfig`). Webhooks are the only pushed field, and there is
 * no GET / diff: when `[experimental.webhooks] enabled` is true the command
 * simply POSTs to enable database webhooks (`V1EnableDatabaseWebhook`).
 *
 * Go: `if exp.Webhooks != nil && exp.Webhooks.Enabled`.
 */
export function experimentalWebhooksEnabled(config: ProjectConfig): boolean {
  const webhooks = config.experimental?.webhooks;
  return webhooks !== undefined && webhooks.enabled;
}
