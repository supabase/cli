import type { ECDH } from "node:crypto";
import type { Effect } from "effect";
import { ServiceMap } from "effect";

export type EncryptedPayload = { ciphertext: string; publicKey: string; nonce: string };

interface CryptoShape {
  readonly generateKeyPair: Effect.Effect<{ ecdh: ECDH; publicKeyHex: string }>;
  readonly generateSessionId: Effect.Effect<string>;
  readonly defaultTokenName: Effect.Effect<string>;
  readonly decryptToken: (ecdh: ECDH, payload: EncryptedPayload) => Effect.Effect<string>;
}

export class Crypto extends ServiceMap.Service<Crypto, CryptoShape>()("supabase/auth/Crypto") {}
