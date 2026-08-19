import type { Effect } from "effect";
import { Context, Layer } from "effect";
import { SchemaLinkedConnectionError } from "../schema/schema-errors.ts";

interface LinkedRemoteConnectorShape {
  readonly connect: (projectRef: string) => Effect.Effect<string, SchemaLinkedConnectionError>;
}

export class LinkedRemoteConnector extends Context.Service<
  LinkedRemoteConnector,
  LinkedRemoteConnectorShape
>()("supabase/database/LinkedRemoteConnector") {}

export const failClosedLinkedRemoteConnectorLayer = Layer.succeed(LinkedRemoteConnector, {
  connect: (projectRef) =>
    new SchemaLinkedConnectionError({
      detail: `Linked project ${projectRef} has no connection string in this environment.`,
      suggestion:
        "Set DATABASE_URL / SUPABASE_DB_URL and pass --allow-remote, or use the stable CLI to connect via the linked project.",
    }),
});
