/** `[auth.email]`/`[auth.sms]` keys where the preferred `enabled` replaces the legacy `enable_signup`. */
export const PROVIDER_SIGNUP_ALIASES = [
  { path: ["auth", "email"], preferred: "enabled", legacy: "enable_signup" },
  { path: ["auth", "sms"], preferred: "enabled", legacy: "enable_signup" },
] as const;
