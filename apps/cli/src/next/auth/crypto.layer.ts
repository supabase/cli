import { Buffer } from "node:buffer";
import { createDecipheriv, createECDH, randomUUID, type ECDH } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { Effect, Layer } from "effect";

import { Crypto, type EncryptedPayload } from "./crypto.service.ts";

export const cryptoLayer = Layer.sync(Crypto, () =>
  Crypto.of({
    generateKeyPair: Effect.sync(() => {
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      return { ecdh, publicKeyHex: ecdh.getPublicKey("hex", "uncompressed") };
    }),
    generateSessionId: Effect.sync(() => randomUUID()),
    defaultTokenName: Effect.sync(() => {
      const ts = Date.now();
      try {
        const user = userInfo().username;
        const host = hostname();
        if (user && host) return `cli_${user}@${host}_${ts}`;
      } catch {
        /* fall through */
      }
      return `cli_${ts}`;
    }),
    decryptToken: (ecdh: ECDH, payload: EncryptedPayload) =>
      Effect.sync(() => {
        const sharedSecret = ecdh.computeSecret(Buffer.from(payload.publicKey, "hex"));
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
      }),
  }),
);
