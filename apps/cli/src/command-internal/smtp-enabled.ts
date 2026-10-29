import type { ResolvedCliConfig } from "../config/cli-config-values.service.ts";

/** A present `[auth.email.smtp]` table without `enabled` counts as on; the schema default is off. */
export const resolveSmtpEnabled = (resolvedConfig: ResolvedCliConfig): boolean =>
  resolvedConfig.materialized.originAt("auth.email.smtp.enabled").tier === "default"
    ? resolvedConfig.declares("auth.email.smtp")
    : resolvedConfig.materialized.config.auth.email.smtp?.enabled === true;
