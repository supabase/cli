import type { ECDH } from "node:crypto";
import type { Effect } from "effect";
import { Context } from "effect";

import type { LoginCryptoError, LoginDecryptError } from "./login.errors.ts";

export type LoginEncryptedPayload = {
  readonly ciphertext: string;
  readonly publicKey: string;
  readonly nonce: string;
};

interface LoginCryptoShape {
  /**
   * Generates a P-256 (prime256v1) ECDH keypair and the uncompressed, hex-encoded public key
   * sent to the dashboard.
   */
  readonly generateKeyPair: Effect.Effect<
    { readonly ecdh: ECDH; readonly publicKeyHex: string },
    LoginCryptoError
  >;
  /** Fresh login session UUID. */
  readonly generateSessionId: Effect.Effect<string>;
  /**
   * Default token name `cli_<user>@<host>_<unix>`, falling back to `cli_<unix>` when the
   * username/hostname lookup fails.
   */
  readonly defaultTokenName: Effect.Effect<string>;
  /** Derives the ECDH shared secret and AES-256-GCM decrypts the access token. */
  readonly decryptToken: (
    ecdh: ECDH,
    payload: LoginEncryptedPayload,
  ) => Effect.Effect<string, LoginDecryptError>;
}

export class LoginCrypto extends Context.Service<LoginCrypto, LoginCryptoShape>()(
  "supabase/cli/LoginCrypto",
) {}
