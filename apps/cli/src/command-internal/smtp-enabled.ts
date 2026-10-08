import type { CliConfigSnapshot } from "../config/cli-config-values.service.ts";

/** A present `[auth.email.smtp]` table without `enabled` counts as on; the schema default is off. */
export const resolveSmtpEnabled = (snapshot: CliConfigSnapshot): boolean =>
  snapshot.materialized.originAt("auth.email.smtp.enabled").tier === "default"
    ? snapshot.declares("auth.email.smtp")
    : snapshot.materialized.config.auth.email.smtp?.enabled === true;
