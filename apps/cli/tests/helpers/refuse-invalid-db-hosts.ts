import type * as NodeNet from "node:net";

/**
 * Wraps `node:net` so a connection to a `db.<ref>.invalid` fixture host fails at once instead of
 * waiting on ambient DNS or TCP timing. Use it from a test file's `vi.mock("node:net", ...)`
 * factory; other hosts connect normally. A test that needs the direct host to connect sets
 * `directHostReachable` on the object it passes (created with `vi.hoisted`) for its duration.
 */
export function refuseInvalidDbHosts(
  net: typeof NodeNet,
  options: { readonly directHostReachable: boolean } = { directHostReachable: false },
) {
  return {
    ...net,
    connect: (connectOptions: NodeNet.NetConnectOpts) => {
      const host = "host" in connectOptions ? connectOptions.host : undefined;
      if (typeof host !== "string" || !host.startsWith("db.") || !host.endsWith(".invalid")) {
        return net.connect(connectOptions);
      }
      const socket = new net.Socket();
      queueMicrotask(() =>
        options.directHostReachable
          ? socket.emit("connect")
          : socket.emit("error", new Error("fixture connection refused")),
      );
      return socket;
    },
  };
}
