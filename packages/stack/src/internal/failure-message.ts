import { Predicate } from "effect";
import type { RpcClientError } from "effect/rpc/RpcClientError";

/** Describes a failure as a string; Effect errors such as `Cause.UnknownError` can lack a message. */
export const failureMessage = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause);
  const visited = new Set<Error>();
  let current: unknown = cause;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    const message: unknown = current.message;
    if (typeof message === "string" && message.length > 0) return message;
    current = current.cause;
  }
  return current === undefined || current instanceof Error ? cause.name : failureMessage(current);
};

const describeLink = (link: Error): string | undefined => {
  const code =
    Predicate.hasProperty(link, "code") && typeof link.code === "string" ? link.code : undefined;
  if (link.message.length === 0) return code;
  return code === undefined ? link.message : `${link.message} (${code})`;
};

/**
 * Describes an owner RPC client failure with its transport kind and every nested cause message and
 * error code, which `RpcClientError.message` drops for a serialized HTTP failure.
 */
export const rpcClientFailureMessage = (error: RpcClientError): string => {
  const { reason } = error;
  const parts = [
    Predicate.hasProperty(reason, "kind") && typeof reason.kind === "string"
      ? `${reason._tag} ${reason.kind}`
      : reason._tag,
  ];
  const visited = new Set<unknown>();
  let current: unknown = reason;
  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);
    const part = current instanceof Error ? describeLink(current) : failureMessage(current);
    if (part !== undefined && part !== parts.at(-1)) parts.push(part);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(": ");
};

/** The lease as a client sees it after a call to the owner at `pid` lost its connection. */
export type LostOwnerLease =
  | { readonly _tag: "Held" }
  | { readonly _tag: "Released" }
  | { readonly _tag: "Replaced"; readonly holderPid: number }
  | { readonly _tag: "Unknown"; readonly reason: string };

/** What a client observes about a stack owner after a call to it lost its connection. */
export interface LostOwnerObservation {
  /** The pid the call was sent to. */
  readonly pid: number;
  readonly lease: LostOwnerLease;
  readonly log: string;
  /** The owner log tail; absent when the log may belong to a replacement owner. */
  readonly logTail: string;
}

/** Says whether the called owner still runs and adds its log tail, so a crash reads as one. */
export const lostOwnerDetail = ({ pid, lease, log, logTail }: LostOwnerObservation): string => {
  const liveness =
    lease._tag === "Held"
      ? `owner ${pid} still holds the stack lease`
      : lease._tag === "Released"
        ? `owner ${pid} no longer holds the stack lease`
        : lease._tag === "Replaced"
          ? `owner ${pid} no longer holds the stack lease; owner ${lease.holderPid} holds it now`
          : `the stack lease of owner ${pid} could not be read: ${lease.reason}`;
  return `${liveness} (owner log: ${log})${logTail.length === 0 ? "" : `\n${logTail}`}`;
};
