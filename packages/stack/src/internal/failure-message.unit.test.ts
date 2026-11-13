import { describe, expect, it } from "@effect/vitest";
import { HttpClientError, HttpClientRequest } from "effect/http";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import { rpcClientFailureMessage } from "./failure-message.ts";

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

    expect(error.message).toBe("HttpError: ");
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
