import { Data, Effect, Predicate, Schema } from "effect";
import { isStackId, StackIdSchema } from "../public/StackId.ts";

/** The stable protocol is intentionally frozen independently of Stack RPC releases. */
const MAINTENANCE_PROTOCOL = "maintenance-v1" as const;
export const MAINTENANCE_MAX_CONCURRENT_REQUESTS = 16;
export const MAINTENANCE_REQUEST_DEADLINE_MS = 5_000;
export const CONTROL_PREFACE_MAX_BYTES = 256;

export class MaintenanceProtocolError extends Data.TaggedError("MaintenanceProtocolError")<{
  readonly message: string;
  readonly reason?: string;
}> {}

/** Errors that indicate an owner endpoint is unavailable rather than rejecting a request. */
export const isMaintenanceTransportFailure = (error: unknown): boolean => {
  if (Predicate.isTagged(error, "SocketError")) return true;
  if (!Predicate.isTagged(error, "MaintenanceProtocolError")) return false;
  return Predicate.hasProperty(error, "reason") && error.reason === "transport";
};

const ownerSessionIdIsValid = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);

export const OwnerSessionIdSchema = Schema.String.pipe(
  Schema.refine((value): value is string => ownerSessionIdIsValid(value), {
    identifier: "OwnerSessionId",
    message: "Expected a bounded owner session identifier",
  }),
);

const ReleaseTokenSchema = Schema.String.pipe(
  Schema.refine(
    (value): value is string => value.length > 0 && value.length <= 128 && /^[^\s]+$/.test(value),
    {
      identifier: "ControlRelease",
      message: "Expected a bounded release token without whitespace",
    },
  ),
);

export const MaintenanceRequestSchema = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("probe"),
    stackId: StackIdSchema,
    ownerSessionId: OwnerSessionIdSchema,
  }),
  Schema.Struct({
    op: Schema.Literal("stop"),
    stackId: StackIdSchema,
    ownerSessionId: OwnerSessionIdSchema,
  }),
]);
export type MaintenanceRequest = Schema.Schema.Type<typeof MaintenanceRequestSchema>;

const MaintenanceErrorCodeSchema = Schema.Literals([
  "invalid-request",
  "stale-session",
  "timeout",
  "operation-failed",
  "unsupported-release",
] as const);
const MaintenanceStackErrorTagSchema = Schema.String;

export const MaintenanceResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    op: Schema.Literal("probe"),
    ownerSessionId: OwnerSessionIdSchema,
    stackId: StackIdSchema,
    rpcRelease: ReleaseTokenSchema,
  }),
  Schema.Struct({ ok: Schema.Literal(true), op: Schema.Literal("stop") }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      tag: MaintenanceErrorCodeSchema,
      message: Schema.String,
      stackErrorTag: Schema.optionalKey(MaintenanceStackErrorTagSchema),
    }),
  }),
]);
export type MaintenanceResponse = Schema.Schema.Type<typeof MaintenanceResponseSchema>;

export type ControlProtocol =
  | {
      readonly kind: "maintenance";
      readonly release: typeof MAINTENANCE_PROTOCOL;
      readonly stackId: string;
      readonly ownerSessionId: string;
    }
  | {
      readonly kind: "rpc";
      readonly release: string;
      readonly stackId: string;
      readonly ownerSessionId: string;
    };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const encodePreface = (protocol: ControlProtocol): Uint8Array =>
  textEncoder.encode(
    `supabase-stack/1 ${protocol.kind}:${protocol.release} stackId:${protocol.stackId} ownerSessionId:${protocol.ownerSessionId}\n`,
  );

export const decodePreface = (
  bytes: Uint8Array,
): Effect.Effect<
  { readonly protocol: ControlProtocol; readonly consumed: number },
  MaintenanceProtocolError
> =>
  Effect.gen(function* () {
    const newline = bytes.indexOf(10);
    if (newline < 0) {
      return yield* new MaintenanceProtocolError({ message: "Control preface is incomplete" });
    }
    if (newline + 1 > CONTROL_PREFACE_MAX_BYTES) {
      return yield* new MaintenanceProtocolError({ message: "Control preface exceeds size limit" });
    }
    const value = yield* Effect.try({
      try: () => textDecoder.decode(bytes.slice(0, newline)),
      catch: () => new MaintenanceProtocolError({ message: "Control preface is invalid" }),
    });
    const match =
      /^supabase-stack\/1 (maintenance|rpc):([^ ]+) stackId:([^ ]+) ownerSessionId:([^ ]+)$/.exec(
        value,
      );
    if (match === null) {
      return yield* new MaintenanceProtocolError({ message: "Control preface is invalid" });
    }
    const kind = match[1];
    const release = match[2];
    const stackId = match[3];
    const ownerSessionId = match[4];
    if (
      kind === undefined ||
      release === undefined ||
      stackId === undefined ||
      ownerSessionId === undefined
    ) {
      return yield* new MaintenanceProtocolError({ message: "Control preface is invalid" });
    }
    if (!isStackId(stackId) || !ownerSessionIdIsValid(ownerSessionId)) {
      return yield* new MaintenanceProtocolError({
        message: "Control preface identity is invalid",
      });
    }
    if (kind === "maintenance" && release !== MAINTENANCE_PROTOCOL) {
      return yield* new MaintenanceProtocolError({
        message: "Unsupported maintenance protocol release",
      });
    }
    return {
      protocol:
        kind === "maintenance"
          ? {
              kind: "maintenance",
              release: MAINTENANCE_PROTOCOL,
              stackId,
              ownerSessionId,
            }
          : {
              kind: "rpc",
              release,
              stackId,
              ownerSessionId,
            },
      consumed: newline + 1,
    };
  });
