import { createServer } from "node:net";
import { Data, Effect } from "effect";

export const DEFAULT_API_PORT = 54321;
export const DEFAULT_DB_PORT = 54322;
const DEFAULT_STUDIO_PORT = 54323;
const DEFAULT_MAILPIT_PORT = 54324;
const DEFAULT_MAILPIT_SMTP_PORT = 54325;
const DEFAULT_MAILPIT_POP3_PORT = 54326;
const DEFAULT_ANALYTICS_PORT = 54327;
const DEFAULT_POOLER_PORT = 54329;

export class PortAllocationError extends Data.TaggedError("PortAllocationError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface PortInput {
  readonly apiPort?: number;
  readonly dbPort?: number;
  readonly authPort?: number;
  readonly postgrestPort?: number;
  readonly postgrestAdminPort?: number;
  readonly realtimePort?: number;
  readonly storagePort?: number;
  readonly imgproxyPort?: number;
  readonly mailpitPort?: number;
  readonly mailpitSmtpPort?: number;
  readonly mailpitPop3Port?: number;
  readonly pgmetaPort?: number;
  readonly studioPort?: number;
  readonly analyticsPort?: number;
  readonly poolerPort?: number;
  readonly poolerApiPort?: number;
}

export interface AllocatedPorts {
  readonly apiPort: number;
  readonly dbPort: number;
  readonly authPort: number;
  readonly postgrestPort: number;
  readonly postgrestAdminPort: number;
  readonly realtimePort: number;
  readonly storagePort: number;
  readonly imgproxyPort: number;
  readonly mailpitPort: number;
  readonly mailpitSmtpPort: number;
  readonly mailpitPop3Port: number;
  readonly pgmetaPort: number;
  readonly studioPort: number;
  readonly analyticsPort: number;
  readonly poolerPort: number;
  readonly poolerApiPort: number;
}

export const PORT_FIELDS = [
  "apiPort",
  "dbPort",
  "authPort",
  "postgrestPort",
  "postgrestAdminPort",
  "realtimePort",
  "storagePort",
  "imgproxyPort",
  "mailpitPort",
  "mailpitSmtpPort",
  "mailpitPop3Port",
  "pgmetaPort",
  "studioPort",
  "analyticsPort",
  "poolerPort",
  "poolerApiPort",
] as const satisfies ReadonlyArray<keyof AllocatedPorts>;

type PortField = (typeof PORT_FIELDS)[number];

export const DEFAULT_PORTS: Partial<AllocatedPorts> = {
  apiPort: DEFAULT_API_PORT,
  dbPort: DEFAULT_DB_PORT,
  studioPort: DEFAULT_STUDIO_PORT,
  mailpitPort: DEFAULT_MAILPIT_PORT,
  mailpitSmtpPort: DEFAULT_MAILPIT_SMTP_PORT,
  mailpitPop3Port: DEFAULT_MAILPIT_POP3_PORT,
  analyticsPort: DEFAULT_ANALYTICS_PORT,
  poolerPort: DEFAULT_POOLER_PORT,
};

interface PortAllocationOptions {
  readonly reserved?: ReadonlySet<number>;
  readonly preferred?: Partial<AllocatedPorts>;
}

/** Bind port 0 to get an OS-assigned random port, then close immediately. */
const probeRandomPort = (
  exclude: ReadonlySet<number>,
): Effect.Effect<number, PortAllocationError> =>
  Effect.flatMap(
    Effect.callback<number, PortAllocationError>((resume) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        server.close(() => resume(Effect.succeed(port)));
      });
      server.on("error", (cause) =>
        resume(
          Effect.fail(new PortAllocationError({ detail: "Failed to bind random port", cause })),
        ),
      );
      return Effect.void;
    }),
    (port) => (exclude.has(port) ? probeRandomPort(exclude) : Effect.succeed(port)),
  );

/** Probe the exact port requested by the user. Fail if it is not available. */
const probeExactPort = (port: number): Effect.Effect<number, PortAllocationError> =>
  Effect.callback<number, PortAllocationError>((resume) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resume(Effect.succeed(port)));
    });
    server.on("error", () =>
      resume(Effect.fail(new PortAllocationError({ detail: `Port ${port} is not available` }))),
    );
    return Effect.void;
  });

const chooseExactPort = (
  port: number,
  exclude: ReadonlySet<number>,
): Effect.Effect<number, PortAllocationError> =>
  exclude.has(port)
    ? Effect.fail(new PortAllocationError({ detail: `Port ${port} is not available` }))
    : probeExactPort(port);

const choosePreferredPort = (
  port: number,
  exclude: ReadonlySet<number>,
): Effect.Effect<number, PortAllocationError> =>
  exclude.has(port)
    ? probeRandomPort(exclude)
    : probeExactPort(port).pipe(
        Effect.catchTag("PortAllocationError", () => probeRandomPort(exclude)),
      );

export const allocatePorts = (
  input: PortInput,
  options: PortAllocationOptions = {},
): Effect.Effect<AllocatedPorts, PortAllocationError> =>
  Effect.gen(function* () {
    const reserved = options.reserved ?? new Set<number>();
    const preferred = options.preferred ?? {};
    const allocated = new Set<number>();

    const alloc = (port: number) => {
      allocated.add(port);
      return port;
    };

    const exclude = () => new Set([...reserved, ...allocated]);

    const resolvePort = (field: PortField) => {
      const explicit = input[field];
      if (explicit !== undefined) {
        return chooseExactPort(explicit, exclude());
      }

      const preferredPort = preferred[field];
      if (preferredPort !== undefined) {
        return choosePreferredPort(preferredPort, exclude());
      }

      return probeRandomPort(exclude());
    };

    const resolved = {} as Record<PortField, number>;
    for (const field of PORT_FIELDS) {
      resolved[field] = alloc(yield* resolvePort(field));
    }

    return resolved as AllocatedPorts;
  });
