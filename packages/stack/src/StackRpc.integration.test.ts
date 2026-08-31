import { describe, expect, it } from "vitest";
import { matchesStackRpcFence, StackRpc, STACK_RPC_PATH } from "./StackRpc.ts";

describe("Stack RPC contract", () => {
  it("defines one shared runtime contract at the stable rpc endpoint", () => {
    expect(STACK_RPC_PATH).toBe("/rpc");
    expect([...StackRpc.requests.keys()]).toEqual([
      "GetInfo",
      "StartStack",
      "StartService",
      "StopService",
      "RestartService",
      "WaitStackReady",
      "WaitServiceReady",
      "ReloadFunctions",
      "ReloadEdgeRuntime",
      "UpdateLaunch",
      "GetServiceState",
      "GetAllServiceStates",
      "WatchServiceStates",
      "GetLogHistory",
      "WatchLogs",
    ]);
  });

  it("rejects incomplete fences even when expected values are empty", () => {
    const expected = { ownershipId: "", ownerSessionId: "" };

    expect(matchesStackRpcFence({ "x-supabase-stack-ownership-id": "" }, expected)).toBe(false);
    expect(matchesStackRpcFence({ "x-supabase-stack-owner-session-id": "" }, expected)).toBe(false);
  });
});
