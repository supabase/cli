import type { Effect } from "effect";
import { ServiceMap } from "effect";

import type { ApiError } from "./errors.ts";

export type LoginSessionResponse = {
  access_token: string;
  public_key: string;
  nonce: string;
};

interface ApiShape {
  readonly fetchLoginSession: (
    apiUrl: string,
    sessionId: string,
    deviceCode: string,
  ) => Effect.Effect<LoginSessionResponse, ApiError>;
}

export class Api extends ServiceMap.Service<Api, ApiShape>()("@supabase/cli/auth/Api") {}
