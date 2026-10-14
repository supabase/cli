import type * as NodeNet from "node:net";
import { Effect } from "effect";

/** The switch a test file shares with its `node:net` mock; create it with `vi.hoisted`. */
export interface DirectHostToggle {
  directHostReachable: boolean;
}

/**
 * Wraps `node:net` so a connection to a `db.<ref>.invalid` fixture host fails at once instead of
 * waiting on ambient DNS or TCP timing. Use it from a test file's `vi.mock("node:net", ...)`
 * factory; other hosts connect normally. While the toggle passed in is on, the same hosts report a
 * successful connect instead, which fakes the TCP reachability probe only (nothing is dialed).
 */
export function refuseInvalidDbHosts(
  net: typeof NodeNet,
  toggle: DirectHostToggle = { directHostReachable: false },
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
        toggle.directHostReachable
          ? socket.emit("connect")
          : socket.emit("error", new Error("fixture connection refused")),
      );
      return socket;
    },
  };
}

/** Turns the toggle on for the enclosing scope and back off when it closes, even on failure. */
export const withReachableDirectHost = (toggle: DirectHostToggle) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      toggle.directHostReachable = true;
    }),
    () =>
      Effect.sync(() => {
        toggle.directHostReachable = false;
      }),
  );
