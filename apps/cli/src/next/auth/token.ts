import { Effect } from "effect";
import { InvalidTokenError } from "./errors.ts";

const TOKEN_PATTERN = /^sbp_(oauth_)?[a-f0-9]{40}$/;

export const validateToken = Effect.fnUntraced(function* (token: string) {
  if (!TOKEN_PATTERN.test(token)) {
    return yield* new InvalidTokenError({
      detail: "Invalid access token format",
      suggestion: "Generate a token at https://supabase.com/dashboard/account/tokens",
    });
  }
});
