import type { V1GetProfileOutput } from "@supabase/api/effect";

import { renderGlamourTable } from "../../output/glamour-table.ts";

type Profile = typeof V1GetProfileOutput.Type;

const HEADERS = ["USER ID", "USERNAME", "EMAIL"] as const;

export function renderWhoamiTable(profile: Profile): string {
  return renderGlamourTable(HEADERS, [
    [profile.gotrue_id, profile.username, profile.primary_email],
  ]);
}
