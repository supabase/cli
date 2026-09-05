import { Effect, Schema } from "effect";
import { MaintenanceProtocolError } from "./MaintenanceProtocol.ts";

export const MAINTENANCE_MAX_FRAME_BYTES = 64 * 1024;
/** RPC payloads may include the complete retained log window plus serialization overhead. */
export const RPC_MAX_FRAME_BYTES = 2 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

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

const encodeBoundedFrame = (
  body: Uint8Array,
  maxBytes: number,
): Effect.Effect<Uint8Array, MaintenanceProtocolError> => {
  if (body.byteLength > maxBytes) {
    return Effect.fail(
      new MaintenanceProtocolError({ message: "Control frame exceeds size limit" }),
    );
  }
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return Effect.succeed(frame);
};

/** Encode one bounded uint32-big-endian frame containing JSON. */
export const encodeFrame = (
  value: JsonValue,
): Effect.Effect<Uint8Array, MaintenanceProtocolError> =>
  encodeJson(value).pipe(
    Effect.flatMap((body) => encodeBoundedFrame(body, MAINTENANCE_MAX_FRAME_BYTES)),
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

  push(
    chunk: Uint8Array,
    maxFrameBytes = MAINTENANCE_MAX_FRAME_BYTES,
  ): Effect.Effect<ReadonlyArray<Uint8Array>, MaintenanceProtocolError> {
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
      if (length > maxFrameBytes) {
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
}

/** Encode a raw RPC serialization payload in the same bounded frame format. */
export const encodeRawFrame = (
  value: Uint8Array | string,
): Effect.Effect<Uint8Array, MaintenanceProtocolError> =>
  Effect.sync(() => (typeof value === "string" ? textEncoder.encode(value) : value)).pipe(
    Effect.flatMap((body) => encodeBoundedFrame(body, RPC_MAX_FRAME_BYTES)),
  );
