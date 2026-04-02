import type { Effect, Redacted } from "effect";
import { ServiceMap } from "effect";

import type { ApiError } from "./errors.ts";

export type LoginSessionResponse = {
  access_token: string;
  public_key: string;
  nonce: string;
};

export type ProfileResponse = {
  gotrue_id: string;
  primary_email: string;
  username: string;
};

interface ApiShape {
  readonly fetchLoginSession: (
    apiUrl: string,
    sessionId: string,
    deviceCode: string,
  ) => Effect.Effect<LoginSessionResponse, ApiError>;
  readonly fetchProfile: (
    apiUrl: string,
    accessToken: string | Redacted.Redacted<string>,
  ) => Effect.Effect<ProfileResponse, ApiError>;
}

export class Api extends ServiceMap.Service<Api, ApiShape>()("@supabase/cli/auth/Api") {}
