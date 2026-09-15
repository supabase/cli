import { Context, Effect, Layer, type Scope } from "effect";

import type { RealtimeInvalidUrlError, RealtimeJoinFailedError } from "./realtime.errors.ts";
import {
  realtimeSession,
  type RealtimeSession,
  type RealtimeSessionSpec,
} from "./realtime.session.ts";

interface RealtimeSessionsShape {
  readonly open: (
    spec: RealtimeSessionSpec,
  ) => Effect.Effect<
    RealtimeSession,
    RealtimeInvalidUrlError | RealtimeJoinFailedError,
    Scope.Scope
  >;
}

export class RealtimeSessions extends Context.Service<RealtimeSessions, RealtimeSessionsShape>()(
  "supabase/realtime/RealtimeSessions",
) {}

export const realtimeSessionsLayer = Layer.succeed(
  RealtimeSessions,
  RealtimeSessions.of({ open: realtimeSession }),
);
