import type { Effect } from "effect";
import { Context } from "effect";
import type { SchemaLinkedConnectionError } from "../schema/schema-errors.ts";

interface LinkedRemoteConnectorShape {
  readonly connect: (projectRef: string) => Effect.Effect<string, SchemaLinkedConnectionError>;
}

export class LinkedRemoteConnector extends Context.Service<
  LinkedRemoteConnector,
  LinkedRemoteConnectorShape
>()("supabase/database/LinkedRemoteConnector") {}
