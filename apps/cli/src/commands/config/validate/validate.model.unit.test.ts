import { describe, expect, it } from "vitest";

import { splitRemotePath } from "./validate.model.ts";

describe("splitRemotePath", () => {
  it("separates the remote name from the path inside the remote", () => {
    expect(splitRemotePath(["remotes", "staging", "api", "port"])).toEqual({
      remote: "staging",
      path: ["api", "port"],
    });
  });

  it("leaves a base path alone", () => {
    expect(splitRemotePath(["api", "port"])).toEqual({ path: ["api", "port"] });
  });
});
