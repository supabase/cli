import type { FeedbackEnvironment } from "../../../shared/feedback/feedback-config.ts";
import { FEEDBACK_PRODUCTION, FEEDBACK_STAGING } from "../../../shared/feedback/feedback-config.ts";

/**
 * Profile → feedback environment. Total lookup with a production fallback for
 * unknown and YAML-file profiles, mirroring `legacy-profile.ts`.
 */
export function legacyFeedbackEnvironment(profile: string): FeedbackEnvironment {
  switch (profile) {
    case "supabase-staging":
    case "supabase-local":
      return FEEDBACK_STAGING;
    default:
      return FEEDBACK_PRODUCTION;
  }
}
