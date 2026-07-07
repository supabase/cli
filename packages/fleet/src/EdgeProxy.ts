import { connect, createServer, type Server, type Socket } from "node:net";

export interface PodUpstream {
  readonly host: string;
  readonly port: number;
}

export interface EdgeProxyEvents {
  /** Fired on connect/disconnect/bytes; IdleMonitor consumes these. */
  onActivity: (
    podId: string,
    event: "connect" | "data" | "disconnect",
    openConnections: number,
  ) => void;
}

interface Registration {
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

/**
 * TCP wake-proxy: binds a pod's external port once and keeps it bound for
 * the pod's lifetime. Every accepted client connection is paused, then
 * `wake()` is awaited to obtain the pod's live upstream address before
 * splicing bytes both ways. Activity (connect/data/disconnect) is reported
 * per pod so the idle monitor can track usage without touching sockets
 * itself.
 *
 * Design assumptions:
 * - **wake() is per-connection, not deduped here.** Two concurrent
 *   connections to a suspended pod may each call `wake()`; dedup (e.g.
 *   collapsing concurrent wakes into a single in-flight promise) is the
 *   fleet layer's responsibility, not EdgeProxy's. Both connections must
 *   still succeed regardless of how many times `wake()` runs.
 * - **wake() rejection destroys the client.** If `wake()` rejects, the
 *   accepted client socket is destroyed and no upstream connection is
 *   attempted. The rejection is handled inline (never left as a dangling
 *   promise) so it can never surface as an unhandled rejection.
 */
export class EdgeProxy {
  private readonly registrations = new Map<string, Registration>();

  constructor(private readonly events: Partial<EdgeProxyEvents> = {}) {}

  openConnections(podId: string): number {
    return this.registrations.get(podId)?.sockets.size ?? 0;
  }

  register(podId: string, listenPort: number, wake: () => Promise<PodUpstream>): Promise<void> {
    const sockets = new Set<Socket>();
    const emit = (event: "connect" | "data" | "disconnect") =>
      this.events.onActivity?.(podId, event, sockets.size);

    const server = createServer((client) => {
      sockets.add(client);
      emit("connect");

      let disconnected = false;
      const cleanup = () => {
        if (disconnected) return;
        disconnected = true;
        sockets.delete(client);
        emit("disconnect");
      };
      client.on("close", cleanup);
      client.on("error", cleanup);

      // Hold any bytes the client sends while `wake()` is in flight. Merely
      // calling `client.pause()` is not sufficient: some runtimes start
      // sockets flowing before user code gets a chance to react, silently
      // dropping data received before a listener is attached. Attaching a
      // real `data` listener up front guarantees nothing is lost; buffered
      // chunks are replayed to the backend once it's connected, then the
      // socket is handed off to `pipe()` for the rest of the stream.
      const buffered: Buffer[] = [];
      const bufferChunk = (chunk: Buffer) => buffered.push(chunk);
      client.on("data", bufferChunk);
      client.pause();

      wake().then(
        (upstream) => {
          // The client may have already disconnected while wake() was
          // in flight; don't bother connecting an upstream nobody needs.
          if (disconnected) return;

          const backend = connect(upstream.port, upstream.host);
          backend.on("error", () => {
            client.destroy();
            backend.destroy();
          });
          client.on("close", () => backend.destroy());
          backend.on("close", () => client.destroy());
          backend.on("data", () => emit("data"));
          backend.on("connect", () => {
            client.off("data", bufferChunk);
            client.on("data", () => emit("data"));
            for (const chunk of buffered) {
              backend.write(chunk);
              emit("data");
            }
            client.pipe(backend);
            backend.pipe(client);
            client.resume();
          });
        },
        () => {
          // wake() failed: destroy the client without letting the
          // rejection escape as an unhandled rejection.
          client.destroy();
        },
      );
    });

    this.registrations.set(podId, { server, sockets });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, "127.0.0.1", () => resolve());
    });
  }

  async unregister(podId: string): Promise<void> {
    const reg = this.registrations.get(podId);
    if (!reg) return;
    this.registrations.delete(podId);
    for (const sock of reg.sockets) sock.destroy();
    await new Promise<void>((resolve) => reg.server.close(() => resolve()));
  }

  async close(): Promise<void> {
    await Promise.all([...this.registrations.keys()].map((id) => this.unregister(id)));
  }
}
