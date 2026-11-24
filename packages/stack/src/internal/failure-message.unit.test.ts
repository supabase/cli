import { describe, expect, it } from "@effect/vitest";
import { HttpClientError, HttpClientRequest } from "effect/http";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import { lostOwnerDetail, rpcClientFailureMessage } from "./failure-message.ts";

describe("rpcClientFailureMessage", () => {
  it("keeps the transport kind, nested messages and socket code of a closed owner HTTP stream", () => {
    const socketClosed = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const transport = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request: HttpClientRequest.post("http://127.0.0.1:54321/rpc"),
        cause: new TypeError("fetch failed", { cause: socketClosed }),
      }),
    });
    const error = new RpcClientError({
      reason: HttpClientError.HttpClientErrorSchema.fromHttpClientError(transport),
    });

    expect(rpcClientFailureMessage(error)).toBe(
      "HttpError TransportError: Transport error (POST http://127.0.0.1:54321/rpc): fetch failed: other side closed (UND_ERR_SOCKET)",
    );
  });

  it("describes a client defect by its message", () => {
    const error = new RpcClientError({
      reason: new RpcClientDefect({ message: "closed", cause: undefined }),
    });

    expect(rpcClientFailureMessage(error)).toBe("RpcClientDefect: closed");
  });
});

describe("lostOwnerDetail", () => {
  it("reports an owner that lost its lease with the tail of its log", () => {
    const detail = lostOwnerDetail({
      pid: 4242,
      lease: { _tag: "Released" },
      log: "/state/stack/owner.log",
      logTail: "panic(main thread): Segmentation fault",
    });

    expect(detail).toBe(
      "owner 4242 no longer holds the stack lease (owner log: /state/stack/owner.log)\npanic(main thread): Segmentation fault",
    );
  });

  it("reports an owner that still holds the lease and has an empty log", () => {
    expect(
      lostOwnerDetail({
        pid: 4242,
        lease: { _tag: "Held" },
        log: "/state/stack/owner.log",
        logTail: "",
      }),
    ).toBe("owner 4242 still holds the stack lease (owner log: /state/stack/owner.log)");
  });

  it("does not claim a released lease when the lease could not be read", () => {
    expect(
      lostOwnerDetail({
        pid: 4242,
        lease: { _tag: "Unknown", reason: "EACCES" },
        log: "/state/stack/owner.log",
        logTail: "",
      }),
    ).toBe(
      "the stack lease of owner 4242 could not be read: EACCES (owner log: /state/stack/owner.log)",
    );
  });
});
