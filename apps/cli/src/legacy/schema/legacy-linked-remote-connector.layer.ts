import { Effect, Layer, Option } from "effect";
import { LinkedRemoteConnector } from "../../shared/database/linked-remote-connector.service.ts";
import { SchemaLinkedConnectionError } from "../../shared/schema/schema-errors.ts";
import { LegacyDnsResolverFlag } from "../../shared/legacy/global-flags.ts";
import { legacyBuildConnectionUrl } from "../shared/legacy-db-connection.sql-pg.layer.ts";
import { LegacyDbConfigResolver } from "../shared/legacy-db-config.service.ts";

function toLinkedConnectionError(error: unknown): SchemaLinkedConnectionError {
  const detail =
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
      ? error.message
      : "Failed to connect to the linked project.";
  const suggestion =
    error !== null &&
    typeof error === "object" &&
    "suggestion" in error &&
    typeof error.suggestion === "string" &&
    error.suggestion.length > 0
      ? error.suggestion
      : "Run `supabase link`, or pass --db-url with a connection string.";
  return new SchemaLinkedConnectionError({ detail, suggestion });
}

export const legacyLinkedRemoteConnectorLayer = Layer.effect(
  LinkedRemoteConnector,
  Effect.gen(function* () {
    const resolver = yield* LegacyDbConfigResolver;
    const dnsFlag = yield* Effect.serviceOption(LegacyDnsResolverFlag);
    const dnsResolver = Option.getOrUndefined(dnsFlag) ?? "native";

    return LinkedRemoteConnector.of({
      connect: (projectRef) =>
        resolver
          .resolve({
            dbUrl: Option.none(),
            connType: "linked",
            dnsResolver,
            linkedProjectRef: Option.some(projectRef),
          })
          .pipe(
            Effect.map((resolved) =>
              legacyBuildConnectionUrl(resolved.conn, resolved.conn.host, resolved.conn.port),
            ),
            Effect.mapError(toLinkedConnectionError),
          ),
    });
  }),
);
