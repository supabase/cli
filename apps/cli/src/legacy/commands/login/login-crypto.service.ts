import type { ECDH } from "node:crypto";
import type { Effect } from "effect";
import { Context } from "effect";

import type { LegacyLoginCryptoError, LegacyLoginDecryptError } from "./login.errors.ts";

export type LegacyEncryptedPayload = {
  readonly ciphertext: string;
  readonly publicKey: string;
  readonly nonce: string;
};

interface LegacyLoginCryptoShape {
  /**
   * Generates a P-256 (prime256v1) ECDH keypair and the uncompressed,
   * hex-encoded public key sent to the dashboard. Mirrors Go's
   * `LoginEncryption.generateKeys` + `encodedPublicKey` (`login.go:71-84`).
   */
  readonly generateKeyPair: Effect.Effect<
    { readonly ecdh: ECDH; readonly publicKeyHex: string },
    LegacyLoginCryptoError
  >;
  /** Fresh login session UUID (Go's `uuid.New().String()`, `login.go:187`). */
  readonly generateSessionId: Effect.Effect<string>;
  /**
   * Default token name `cli_<user>@<host>_<unix>`, falling back to `cli_<unix>`
   * when the username/hostname lookup fails (`login.go:249-271`).
   */
  readonly defaultTokenName: Effect.Effect<string>;
  /**
   * Derives the ECDH shared secret and AES-256-GCM decrypts the access token.
   * Mirrors Go's `decryptAccessToken` (`login.go:86-128`).
   */
  readonly decryptToken: (
    ecdh: ECDH,
    payload: LegacyEncryptedPayload,
  ) => Effect.Effect<string, LegacyLoginDecryptError>;
}

export class LegacyLoginCrypto extends Context.Service<LegacyLoginCrypto, LegacyLoginCryptoShape>()(
  "supabase/legacy/LoginCrypto",
) {}
