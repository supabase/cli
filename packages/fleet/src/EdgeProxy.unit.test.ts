import { type AddressInfo, connect, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeProxy } from "./EdgeProxy.ts";

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
    await proxy.register("pod-a", listenPort, async () => {
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
    await proxy.register("pod-b", listenPort, async () => ({
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
    await proxy.register("pod-c", listenPort, async () => {
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
    await proxy.register("pod-c", listenPort, async () => ({
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
    await proxy.register("pod-d", listenPort, async () => {
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

    await proxy.register("pod-e", listenPort, async () => {
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
});
