import { type AddressInfo, connect, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeProxy, MAX_PREWAKE_BUFFER_BYTES } from "./EdgeProxy.ts";

function echoServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((sock) => sock.pipe(sock));
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

describe("EdgeProxy", () => {
  const proxies: EdgeProxy[] = [];
  afterEach(async () => {
    for (const p of proxies.splice(0)) await p.close();
  });

  it("wakes on first connection and splices bytes both ways", async () => {
    const { server, port: upstreamPort } = await echoServer();
    let wakes = 0;
    const proxy = new EdgeProxy();
    proxies.push(proxy);
    const listenPort = await freePort();
    await proxy.register("pod-a", "database", listenPort, async () => {
      wakes += 1;
      return { host: "127.0.0.1", port: upstreamPort };
    });

    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(listenPort, "127.0.0.1", () => sock.write("ping"));
      sock.on("data", (d) => {
        resolve(d.toString());
        sock.end();
      });
      sock.on("error", reject);
    });
    expect(reply).toBe("ping");
    expect(wakes).toBe(1);
    server.close();
  });

  it("tracks open connections and reports activity", async () => {
    const { server, port: upstreamPort } = await echoServer();
    const events: string[] = [];
    const proxy = new EdgeProxy({
      onActivity: (id, ev) => events.push(`${id}:${ev}`),
    });
    proxies.push(proxy);
    const listenPort = await freePort();
    await proxy.register("pod-b", "database", listenPort, async () => ({
      host: "127.0.0.1",
      port: upstreamPort,
    }));

    await new Promise<void>((resolve) => {
      const sock = connect(listenPort, "127.0.0.1", () => sock.write("x"));
      sock.on("data", () => sock.end());
      sock.on("close", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContain("pod-b:connect");
    expect(events).toContain("pod-b:data");
    expect(events).toContain("pod-b:disconnect");
    expect(proxy.openConnections("pod-b")).toBe(0);
    server.close();
  });

  it("destroys the client socket when wake() rejects, and stays usable afterward", async () => {
    const proxy = new EdgeProxy();
    proxies.push(proxy);
    const listenPort = await freePort();
    let attempts = 0;
    await proxy.register("pod-c", "database", listenPort, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("wake failed");
      return { host: "127.0.0.1", port: await freePort() };
    });

    // First connection: wake() rejects, socket should close/error without
    // taking down the process (no unhandled rejection) and without wedging
    // the listener.
    await new Promise<void>((resolve) => {
      const sock = connect(listenPort, "127.0.0.1");
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      sock.on("error", finish);
      sock.on("close", finish);
    });

    // Second connection: proxy must still be usable. Use a real echo server
    // for the second wake so we can prove the pipe still works.
    const { server, port: upstreamPort } = await echoServer();
    await proxy.unregister("pod-c");
    await proxy.register("pod-c", "database", listenPort, async () => ({
      host: "127.0.0.1",
      port: upstreamPort,
    }));

    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(listenPort, "127.0.0.1", () => sock.write("hello"));
      sock.on("data", (d) => {
        resolve(d.toString());
        sock.end();
      });
      sock.on("error", reject);
    });
    expect(reply).toBe("hello");
    server.close();
  });

  it("handles two concurrent connections to the same suspended pod, both succeed", async () => {
    const { server, port: upstreamPort } = await echoServer();
    let wakeCalls = 0;
    const proxy = new EdgeProxy();
    proxies.push(proxy);
    const listenPort = await freePort();
    await proxy.register("pod-d", "database", listenPort, async () => {
      wakeCalls += 1;
      // Simulate a suspended pod that takes a bit to wake.
      await new Promise((r) => setTimeout(r, 20));
      return { host: "127.0.0.1", port: upstreamPort };
    });

    const connectAndEcho = (payload: string) =>
      new Promise<string>((resolve, reject) => {
        const sock = connect(listenPort, "127.0.0.1", () => sock.write(payload));
        sock.on("data", (d) => {
          resolve(d.toString());
          sock.end();
        });
        sock.on("error", reject);
      });

    const [replyA, replyB] = await Promise.all([connectAndEcho("aaa"), connectAndEcho("bbb")]);
    expect(replyA).toBe("aaa");
    expect(replyB).toBe("bbb");
    // Contract: wake() may be called once or twice; dedup happens at the
    // fleet layer, not in EdgeProxy.
    expect(wakeCalls).toBeGreaterThanOrEqual(1);
    expect(wakeCalls).toBeLessThanOrEqual(2);
    server.close();
  });

  it("does not connect a dangling backend when unregistered while wake() is in flight", async () => {
    const proxy = new EdgeProxy();
    proxies.push(proxy);
    const listenPort = await freePort();
    const upstreamPort = await freePort(); // nothing listening here

    await proxy.register("pod-e", "database", listenPort, async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { host: "127.0.0.1", port: upstreamPort };
    });

    await new Promise<void>((resolve) => {
      const sock = connect(listenPort, "127.0.0.1", () => sock.write("x"));
      sock.on("error", () => resolve());
      sock.on("close", () => resolve());
      setTimeout(() => {
        proxy.unregister("pod-e").catch(() => {});
      }, 20);
    });

    // Wait past wake()'s resolution point; if EdgeProxy tried to connect a
    // backend for the now-destroyed client, it would leak a socket/listener.
    await new Promise((r) => setTimeout(r, 150));
    expect(proxy.openConnections("pod-e")).toBe(0);
  });

  it("destroys the client if it floods the pre-wake buffer past the cap, and stays usable afterward", async () => {
    const proxy = new EdgeProxy();
    proxies.push(proxy);
    const listenPort = await freePort();

    let unhandledRejection: unknown;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await proxy.register("pod-f", "database", listenPort, async () => {
        // Slow wake gives the flooding client plenty of time to exceed the cap.
        await new Promise((r) => setTimeout(r, 200));
        return { host: "127.0.0.1", port: await freePort() };
      });

      const clientDestroyed = await new Promise<boolean>((resolve) => {
        const sock = connect(listenPort, "127.0.0.1", () => {
          // A single write just over the cap: this floods immediately and
          // reflects that the cap must trigger regardless of how the
          // client chooses to chunk its writes.
          sock.write(Buffer.alloc(MAX_PREWAKE_BUFFER_BYTES + 64 * 1024, "a"));
        });
        sock.on("error", () => resolve(true));
        sock.on("close", () => resolve(sock.destroyed));
      });
      expect(clientDestroyed).toBe(true);

      // Give any lingering wake() resolution a chance to run before we assert
      // there was no unhandled rejection.
      await new Promise((r) => setTimeout(r, 250));
      expect(unhandledRejection).toBeUndefined();

      // Proxy must still be usable for a subsequent normal connection.
      const { server, port: upstreamPort } = await echoServer();
      await proxy.unregister("pod-f");
      await proxy.register("pod-f", "database", listenPort, async () => ({
        host: "127.0.0.1",
        port: upstreamPort,
      }));

      const reply = await new Promise<string>((resolve, reject) => {
        const sock = connect(listenPort, "127.0.0.1", () => sock.write("hello"));
        sock.on("data", (d) => {
          resolve(d.toString());
          sock.end();
        });
        sock.on("error", reject);
      });
      expect(reply).toBe("hello");
      server.close();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("destroys the client without an unhandled rejection when wake() resolves with a garbage upstream", async () => {
    const proxy = new EdgeProxy();
    proxies.push(proxy);
    const listenPort = await freePort();

    let unhandledRejection: unknown;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await proxy.register("pod-g", "database", listenPort, async () => ({
        host: "127.0.0.1",
        port: -1,
      }));

      const clientDestroyed = await new Promise<boolean>((resolve) => {
        const sock = connect(listenPort, "127.0.0.1", () => sock.write("x"));
        sock.on("error", () => resolve(true));
        sock.on("close", () => resolve(sock.destroyed));
      });
      expect(clientDestroyed).toBe(true);

      await new Promise((r) => setTimeout(r, 50));
      expect(unhandledRejection).toBeUndefined();

      // Proxy must still be usable for a subsequent normal connection.
      const { server, port: upstreamPort } = await echoServer();
      await proxy.unregister("pod-g");
      await proxy.register("pod-g", "database", listenPort, async () => ({
        host: "127.0.0.1",
        port: upstreamPort,
      }));

      const reply = await new Promise<string>((resolve, reject) => {
        const sock = connect(listenPort, "127.0.0.1", () => sock.write("hello"));
        sock.on("data", (d) => {
          resolve(d.toString());
          sock.end();
        });
        sock.on("error", reject);
      });
      expect(reply).toBe("hello");
      server.close();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
