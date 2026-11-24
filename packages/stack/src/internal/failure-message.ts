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

/** The most an owner failure message quotes from the end of the owner log. */
export const ownerLogTailBytes = 4096;

/** Keeps the last 20 lines of the owner log's final bytes. */
export const ownerLogTailLines = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes).trimEnd().split("\n").slice(-20).join("\n");

/** Points at the owner log and quotes its tail when there is one. */
export const ownerLogReference = (log: string, tail: string): string =>
  `(owner log: ${log})${tail.length === 0 ? "" : `\n${tail}`}`;

/** The lease as a client sees it after a call to the owner at `pid` lost its connection. */
export type LostOwnerLease =
  | { readonly _tag: "Held" }
  | { readonly _tag: "Released" }
  /** Held by a process that has not published its holder record. */
  | { readonly _tag: "Unpublished" }
  | { readonly _tag: "Replaced"; readonly role: "owner" | "sweeper"; readonly holderPid: number }
  | { readonly _tag: "Unknown"; readonly reason: string };

/** What a client observes about a stack owner after a call to it lost its connection. */
export interface LostOwnerObservation {
  /** The pid the call was sent to. */
  readonly pid: number;
  readonly lease: LostOwnerLease;
  readonly log: string;
  /** The owner log tail; empty when the log may belong to a replacement owner. */
  readonly logTail: string;
}

/** Formats the lease status observed after a lost call and the owner log tail, if any. */
export const lostOwnerDetail = ({ pid, lease, log, logTail }: LostOwnerObservation): string => {
  const liveness =
    lease._tag === "Held"
      ? `owner ${pid} still holds the stack lease`
      : lease._tag === "Released"
        ? `owner ${pid} no longer holds the stack lease`
        : lease._tag === "Unpublished"
          ? `the stack lease is held, but no holder record names owner ${pid}`
          : lease._tag === "Replaced"
            ? `owner ${pid} no longer holds the stack lease; ${lease.role === "owner" ? `owner ${lease.holderPid}` : `a sweeper (pid ${lease.holderPid})`} holds it now`
            : `the stack lease of owner ${pid} could not be read: ${lease.reason}`;
  return `${liveness} ${ownerLogReference(log, logTail)}`;
};
