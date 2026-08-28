import { Data, Effect, Schema } from "effect";
import { isStackId, StackIdSchema } from "../public/StackId.ts";

/** The stable protocol is intentionally frozen independently of Stack RPC releases. */
export const MAINTENANCE_PROTOCOL = "maintenance-v1" as const;
export const MAINTENANCE_MAX_FRAME_BYTES = 64 * 1024;
export const MAINTENANCE_MAX_CONCURRENT_REQUESTS = 16;
export const MAINTENANCE_REQUEST_DEADLINE_MS = 5_000;
export const CONTROL_PREFACE_MAX_BYTES = 256;

export class MaintenanceProtocolError extends Data.TaggedError("MaintenanceProtocolError")<{
  readonly message: string;
  readonly reason?: string;
}> {}

export const ownerSessionIdIsValid = (value: string): boolean =>
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
  Schema.Struct({
    op: Schema.Literal("quiesce"),
    stackId: StackIdSchema,
    ownerSessionId: OwnerSessionIdSchema,
  }),
]);
export type MaintenanceRequest = Schema.Schema.Type<typeof MaintenanceRequestSchema>;

export const MaintenanceErrorCodeSchema = Schema.Literals([
  "invalid-request",
  "stale-session",
  "timeout",
  "operation-failed",
  "unsupported-release",
] as const);
export type MaintenanceErrorCode = Schema.Schema.Type<typeof MaintenanceErrorCodeSchema>;

export const MaintenanceResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    op: Schema.Literal("probe"),
    ownerSessionId: OwnerSessionIdSchema,
    stackId: StackIdSchema,
    rpcRelease: ReleaseTokenSchema,
  }),
  Schema.Struct({ ok: Schema.Literal(true), op: Schema.Literals(["stop", "quiesce"] as const) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({ tag: MaintenanceErrorCodeSchema, message: Schema.String }),
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

/** JSON values accepted by the maintenance framing layer. RPC payload schemas remain in RpcGroup. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

const encodeJson = (value: JsonValue): Effect.Effect<Uint8Array, MaintenanceProtocolError> =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.map((text) => textEncoder.encode(text)),
    Effect.mapError(
      () => new MaintenanceProtocolError({ message: "Unable to encode control JSON" }),
    ),
  );

/** Encode one bounded uint32-big-endian frame containing JSON. */
export const encodeFrame = (
  value: JsonValue,
): Effect.Effect<Uint8Array, MaintenanceProtocolError> =>
  encodeJson(value).pipe(
    Effect.flatMap((body) => {
      if (body.byteLength > MAINTENANCE_MAX_FRAME_BYTES) {
        return Effect.fail(
          new MaintenanceProtocolError({ message: "Control frame exceeds size limit" }),
        );
      }
      const frame = new Uint8Array(body.byteLength + 4);
      new DataView(frame.buffer).setUint32(0, body.byteLength, false);
      frame.set(body, 4);
      return Effect.succeed(frame);
    }),
  );

export const decodeFrame = (
  frame: Uint8Array,
): Effect.Effect<JsonValue, MaintenanceProtocolError> =>
  Effect.gen(function* () {
    if (frame.byteLength < 4) {
      return yield* new MaintenanceProtocolError({ message: "Control frame is truncated" });
    }
    const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
    if (length > MAINTENANCE_MAX_FRAME_BYTES) {
      return yield* new MaintenanceProtocolError({ message: "Control frame exceeds size limit" });
    }
    if (frame.byteLength !== length + 4) {
      return yield* new MaintenanceProtocolError({ message: "Control frame length mismatch" });
    }
    const text = yield* Effect.try({
      try: () => textDecoder.decode(frame.slice(4)),
      catch: () => new MaintenanceProtocolError({ message: "Invalid control JSON" }),
    });
    const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
      Effect.mapError(() => new MaintenanceProtocolError({ message: "Invalid control JSON" })),
    );
    if (!isJsonValue(parsed)) {
      return yield* new MaintenanceProtocolError({ message: "Control JSON value is invalid" });
    }
    return parsed;
  });

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
};

/** Incremental bounded frame decoder. Instantiate one per connection execution. */
export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Effect.Effect<ReadonlyArray<Uint8Array>, MaintenanceProtocolError> {
    if (chunk.byteLength === 0) return Effect.succeed([]);
    const combined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    combined.set(this.buffer);
    combined.set(chunk, this.buffer.byteLength);
    this.buffer = combined;
    const frames: Uint8Array[] = [];
    while (this.buffer.byteLength >= 4) {
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(
        0,
        false,
      );
      if (length > MAINTENANCE_MAX_FRAME_BYTES) {
        return Effect.fail(
          new MaintenanceProtocolError({ message: "Control frame exceeds size limit" }),
        );
      }
      if (this.buffer.byteLength < length + 4) break;
      frames.push(this.buffer.slice(0, length + 4));
      this.buffer = this.buffer.slice(length + 4);
    }
    return Effect.succeed(frames);
  }

  get bufferedBytes(): number {
    return this.buffer.byteLength;
  }
}

/** Encode a raw RPC serialization payload in the same bounded frame format. */
export const encodeRawFrame = (
  value: Uint8Array | string,
): Effect.Effect<Uint8Array, MaintenanceProtocolError> =>
  Effect.sync(() => (typeof value === "string" ? textEncoder.encode(value) : value)).pipe(
    Effect.flatMap((body) => {
      if (body.byteLength > MAINTENANCE_MAX_FRAME_BYTES) {
        return Effect.fail(
          new MaintenanceProtocolError({ message: "Control frame exceeds size limit" }),
        );
      }
      const frame = new Uint8Array(body.byteLength + 4);
      new DataView(frame.buffer).setUint32(0, body.byteLength, false);
      frame.set(body, 4);
      return Effect.succeed(frame);
    }),
  );
