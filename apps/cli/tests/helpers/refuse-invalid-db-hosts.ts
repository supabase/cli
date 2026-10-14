import type * as NodeNet from "node:net";

/**
 * Wraps `node:net` so a connection to a `db.<ref>.invalid` fixture host fails at once instead of
 * waiting on ambient DNS or TCP timing. Use it from a test file's `vi.mock("node:net", ...)`
 * factory; other hosts connect normally.
 */
export function refuseInvalidDbHosts(net: typeof NodeNet) {
  return {
    ...net,
    connect: (options: NodeNet.NetConnectOpts) => {
      const host = "host" in options ? options.host : undefined;
      if (typeof host !== "string" || !host.startsWith("db.") || !host.endsWith(".invalid")) {
        return net.connect(options);
      }
      const socket = new net.Socket();
      queueMicrotask(() => socket.emit("error", new Error("fixture connection refused")));
      return socket;
    },
  };
}
