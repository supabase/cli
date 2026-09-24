import { Effect, Schema } from "effect";
import { createSecureContext } from "node:tls";

/** TLS material accepted by a local gateway. */
export const GatewayTlsConfig = Schema.Struct({
  cert: Schema.String,
  key: Schema.String,
});
export interface GatewayTlsConfig extends Schema.Schema.Type<typeof GatewayTlsConfig> {}

/** Optional TLS settings for a local gateway. */
export const GatewayConfig = Schema.Struct({
  tls: Schema.optionalKey(GatewayTlsConfig),
});
export interface GatewayConfig extends Schema.Schema.Type<typeof GatewayConfig> {}

/** A gateway TLS certificate and key could not be decoded or used together. */
class GatewayTlsConfigError extends Schema.TaggedError<GatewayTlsConfigError>()(
  "GatewayTlsConfigError",
  { message: Schema.String },
) {}

/** Decodes gateway configuration and checks the TLS pair with Node's TLS parser. */
export const validateGatewayConfig = (input: unknown) =>
  Schema.decodeUnknownEffect(GatewayConfig)(input).pipe(
    Effect.mapError((cause) => new GatewayTlsConfigError({ message: cause.message })),
    Effect.flatMap((config) => {
      const tls = config.tls;
      return tls === undefined
        ? Effect.succeed(config)
        : Effect.try({
            try: () => {
              createSecureContext({ cert: tls.cert, key: tls.key });
              return config;
            },
            catch: (cause) =>
              new GatewayTlsConfigError({
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          });
    }),
  );
