import { connect, createServer, type Server, type Socket } from "node:net";

export interface PodUpstream {
  readonly host: string;
  readonly port: number;
}

/**
 * Cap on bytes buffered per client while `wake()` is in flight. Postgres
 * startup packets and HTTP request heads are tiny (low kilobytes at most);
 * 1 MiB is generous headroom for either protocol while still bounding memory
 * if a client streams data at a suspended pod during a slow wake. A client
 * that exceeds this cap before the backend is reachable is treated as
 * misbehaving (or attacking) and has its socket destroyed.
 */
export const MAX_PREWAKE_BUFFER_BYTES = 1024 * 1024; // 1 MiB

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
 *   attempted.
 * - **Pre-wake buffering is capped.** Bytes received from the client while
 *   `wake()` is in flight are buffered (see above) up to
 *   `MAX_PREWAKE_BUFFER_BYTES`. A client that exceeds the cap before the
 *   backend is reachable has its socket destroyed; the usual disconnect
 *   activity event still fires exactly once.
 * - **Nothing here can surface as an unhandled rejection.** Both the
 *   rejection path and any synchronous throw from the resolution path
 *   (e.g. `wake()` resolving with a malformed upstream address that makes
 *   `net.connect()` throw) are caught and routed to the same client-destroy
 *   path.
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

      // Hold any bytes the client sends while `wake()` is in flight. A plain
      // `data` listener does not fire while the socket is paused (Node only
      // delivers `data` once flowing, i.e. after `resume()`/`pipe()`), so we
      // use `readable` + `read()` instead: those fire even in paused mode,
      // draining the socket's internal buffer as bytes arrive and letting us
      // count them without ever switching the stream into flowing mode.
      // Buffered chunks are replayed to the backend once it's connected,
      // then the socket is handed off to `pipe()` for the rest of the
      // stream.
      //
      // Buffering is capped at MAX_PREWAKE_BUFFER_BYTES: a client that
      // floods the socket while the backend isn't reachable yet (e.g. a
      // slow wake()) is destroyed rather than allowed to grow this array
      // without bound.
      const buffered: Buffer[] = [];
      let bufferedBytes = 0;
      let overflowed = false;
      const onReadable = () => {
        if (overflowed) return;
        for (;;) {
          const chunk = client.read() as Buffer | null;
          if (chunk === null) return;
          bufferedBytes += chunk.length;
          if (bufferedBytes > MAX_PREWAKE_BUFFER_BYTES) {
            overflowed = true;
            buffered.length = 0;
            client.destroy();
            return;
          }
          buffered.push(chunk);
        }
      };
      client.on("readable", onReadable);
      client.pause();

      wake().then(
        (upstream) => {
          // The client may have already disconnected while wake() was
          // in flight (including due to a pre-wake buffer overflow); don't
          // bother connecting an upstream nobody needs.
          if (disconnected) return;

          try {
            const backend = connect(upstream.port, upstream.host);
            backend.on("error", () => {
              client.destroy();
              backend.destroy();
            });
            client.on("close", () => backend.destroy());
            backend.on("close", () => client.destroy());
            backend.on("data", () => emit("data"));
            backend.on("connect", () => {
              client.off("readable", onReadable);
              client.on("data", () => emit("data"));
              for (const chunk of buffered) {
                backend.write(chunk);
                emit("data");
              }
              client.pipe(backend);
              backend.pipe(client);
              // The activity `data` listener above is independent of the
              // listener `pipe()` attaches internally; both observe the
              // same events, this isn't double-consumption of the stream.
            });
          } catch {
            // wake() resolved, but the upstream address it handed back was
            // unusable (e.g. an invalid port that makes net.connect()
            // throw synchronously). Destroy the client instead of letting
            // the throw escape as an unhandled rejection.
            client.destroy();
          }
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
      const onError = (error: Error) => {
        this.registrations.delete(podId);
        for (const sock of sockets) sock.destroy();
        try {
          server.close(() => reject(error));
        } catch {
          reject(error);
        }
      };
      server.once("error", onError);
      server.listen(listenPort, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
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
