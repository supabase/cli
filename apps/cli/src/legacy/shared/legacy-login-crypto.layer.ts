import { Buffer } from "node:buffer";
import { createDecipheriv, createECDH, randomUUID, type ECDH } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { Effect, Layer } from "effect";

import {
  LegacyLoginCrypto,
  type LegacyEncryptedPayload,
} from "../commands/login/login-crypto.service.ts";
import { LegacyLoginCryptoError, LegacyLoginDecryptError } from "../commands/login/login.errors.ts";

const DECRYPTION_ERROR_MSG = "cannot decrypt access token";

export const legacyLoginCryptoLayer = Layer.sync(LegacyLoginCrypto, () =>
  LegacyLoginCrypto.of({
    generateKeyPair: Effect.try({
      try: () => {
        const ecdh = createECDH("prime256v1");
        ecdh.generateKeys();
        return { ecdh, publicKeyHex: ecdh.getPublicKey("hex", "uncompressed") };
      },
      catch: (cause) =>
        new LegacyLoginCryptoError({ message: `cannot generate crypto keys: ${String(cause)}` }),
    }),
    generateSessionId: Effect.sync(() => randomUUID()),
    defaultTokenName: Effect.sync(() => {
      const ts = Math.floor(Date.now() / 1000);
      try {
        const user = userInfo().username;
        const host = hostname();
        if (user && host) return `cli_${user}@${host}_${ts}`;
      } catch {
        /* fall through to the fallback name (Go's generateTokenNameWithFallback) */
      }
      return `cli_${ts}`;
    }),
    decryptToken: (ecdh: ECDH, payload: LegacyEncryptedPayload) =>
      Effect.try({
        try: () => {
          const sharedSecret = ecdh.computeSecret(Buffer.from(payload.publicKey, "hex"));
          // Go's `aesgcm.Open` expects the 16-byte GCM tag appended to the
          // ciphertext; Node wants it supplied separately via `setAuthTag`.
          const ciphertextHex = payload.ciphertext.slice(0, -32);
          const authTagHex = payload.ciphertext.slice(-32);
          const decipher = createDecipheriv(
            "aes-256-gcm",
            sharedSecret,
            Buffer.from(payload.nonce, "hex"),
          );
          decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
          const decrypted = Buffer.concat([
            decipher.update(Buffer.from(ciphertextHex, "hex")),
            decipher.final(),
          ]);
          return decrypted.toString("utf-8");
        },
        catch: (cause) =>
          new LegacyLoginDecryptError({ message: `${DECRYPTION_ERROR_MSG}: ${String(cause)}` }),
      }),
  }),
);
