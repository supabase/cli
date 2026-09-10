// oxlint-disable effecttsgo/async-function -- test exercises the Promise-based bundler boundary.
import { createContext, SourceTextModule } from "node:vm";
import { describe, expect, it } from "vitest";
import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

describe("stack-owned functions bootstrap", () => {
  it("produces an executable offline service with the expected runtime contract", async () => {
    type ServeOptions = {
      readonly handler: (request: Request) => Promise<Response>;
      readonly onListen: () => void;
    };

    let serveOptions: ServeOptions | undefined;
    const bundled = await bundleServeMainTemplate();
    const sandbox = {
      Deno: {
        env: { get: (_name: string) => undefined, toObject: () => ({}) },
        errors: {},
        serve: (options: ServeOptions) => {
          serveOptions = options;
        },
      },
      EdgeRuntime: { applySupabaseTag: () => undefined },
      AbortController,
      Request,
      Response,
      URL,
      console,
      crypto,
      setTimeout,
      clearTimeout,
      TextEncoder,
      TextDecoder,
    };

    const module = new SourceTextModule(bundled, {
      context: createContext(sandbox),
      identifier: "serve.main.bundle.js",
    });
    await module.link(() => {
      throw new Error("Bundled service unexpectedly imported another module");
    });
    await module.evaluate();

    if (serveOptions === undefined) throw new Error("Bundled service did not register a server");

    const health = await serveOptions.handler(new Request("http://127.0.0.1/_internal/health"));
    expect({ status: health.status, body: await health.json() }).toEqual({
      status: 200,
      body: { message: "ok" },
    });
  });
});
