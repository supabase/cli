import { describe, expect, it } from "vitest";
import { StackRpc, STACK_RPC_PATH } from "./StackRpc.ts";

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
});
