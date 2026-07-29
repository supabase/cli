/**
 * Feedback backend connection config. The keys are publishable (anon) keys,
 * safe to commit — writes are gated by insert-only RLS on the
 * `interfaces_feedback` table, exactly like the docs feedback widget.
 */
export interface FeedbackEnvironment {
  readonly url: string;
  readonly key: string;
}

export const FEEDBACK_STAGING: FeedbackEnvironment = {
  url: "https://imrwaufzgcaczqmpnxyr.supabase.co",
  key: "sb_publishable_puOyAlqG5J_XfBMTDM2Ckw_L5mieFdb",
};

// No dedicated production feedback project exists yet (CLI-1946): production
// intentionally reuses the staging values until one is provisioned.
export const FEEDBACK_PRODUCTION: FeedbackEnvironment = { ...FEEDBACK_STAGING };
