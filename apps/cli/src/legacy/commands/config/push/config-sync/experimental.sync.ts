import type { ProjectConfig } from "@supabase/config";

/**
 * Push-subset of the `experimental` config. Webhooks are the only pushed
 * field, and there is no GET / diff: when `[experimental.webhooks] enabled`
 * is true the command simply POSTs to enable database webhooks
 * (`V1EnableDatabaseWebhook`).
 */
export function experimentalWebhooksEnabled(config: ProjectConfig): boolean {
  const webhooks = config.experimental?.webhooks;
  return webhooks !== undefined && webhooks.enabled;
}
