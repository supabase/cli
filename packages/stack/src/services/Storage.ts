import { Cause, Crypto, Effect, FileSystem, Path, Ref, Schema, Stream } from "effect";
import { resolveArtifact } from "../Artifacts.ts";
import type { ContainerMount, ContainerRuntime } from "../runtime/Container.ts";
import { mapToServiceError } from "../runtime/Session.ts";
import { ServiceError } from "../Service.ts";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { databaseConnection, requiredInput, localJwtSecret, serviceJwt } from "./ServiceConfig.ts";
import { type ProcessRecipeSpec, type StartupCommand } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  databaseUrl: Schema.optionalKey(Schema.String),
  /** Host directory for uploaded objects; see {@link makeUploadsMount} for container runtimes. */
  filePath: Schema.String,
  jwtSecret: Schema.optionalKey(Schema.String),
  jwks: Schema.optionalKey(Schema.String),
  anonKey: Schema.optionalKey(Schema.String),
  serviceRoleKey: Schema.optionalKey(Schema.String),
  imgproxyUrl: Schema.optionalKey(Schema.String),
  fileSizeLimit: Schema.optionalKey(Schema.String),
  s3ProtocolEnabled: Schema.optionalKey(Schema.Boolean),
  vectorEnabled: Schema.optionalKey(Schema.Boolean),
  vectorDatabaseUrl: Schema.optionalKey(Schema.String),
  vectorMaxBuckets: Schema.optionalKey(Schema.Finite),
  vectorMaxIndexes: Schema.optionalKey(Schema.Finite),
});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("storage", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export const initializationCommand = {
  args: [],
  containerEntrypoint: "/slim-runtime/bin/prepare",
  withoutMounts: true,
} satisfies StartupCommand & { readonly containerEntrypoint: string };

// TODO(STORAGE-825): drop the probe once Storage works without extended attributes.
/** How a container sees a Storage `filePath` at `/mnt`; Imgproxy reads the same objects. */
export type UploadsMount = (mount: {
  readonly filePath: string;
  readonly readOnly: boolean;
  /** The Storage artifact version whose image runs the probe; the default when omitted. */
  readonly version?: string;
}) => Effect.Effect<ContainerMount, ServiceError>;

const xattrProbe = `import("/slim-runtime/app/node_modules/fs-xattr/index.js").then(({ setAttributeSync }) => {
  const fs = require("node:fs");
  const file = "/probe/" + process.env.PROBE_FILE;
  try {
    fs.writeFileSync(file, "");
  } catch (error) {
    if (!["EROFS", "EACCES", "EPERM"].includes(error.code)) throw error;
    console.log("read-only");
    return;
  }
  try {
    setAttributeSync(file, "user.supabase.probe", "1");
    console.log("supported");
  } catch (error) {
    if (error.code !== "ENOTSUP" && error.code !== "EOPNOTSUPP") throw error;
    console.log("unsupported");
  } finally {
    fs.rmSync(file, { force: true });
  }
})`;

/**
 * Mounts a stack-volume keyed by `filePath` once one exists or when the engine's file sharing
 * drops the extended attributes Storage writes as object metadata, as Docker Desktop's does, and
 * otherwise bind-mounts `filePath`, including when it is not writable. Each `filePath` is decided
 * once per resolver.
 */
export const makeUploadsMount = Effect.fn("Storage.makeUploadsMount")(function* (options: {
  readonly container: ContainerRuntime | undefined;
  readonly stackId: string;
  readonly instanceId: string;
  readonly project?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const answers = yield* Ref.make<ReadonlyMap<string, boolean>>(new Map());
  const keepsBindMount = Effect.fn("Storage.probeUploadsDirectory")(function* (
    container: ContainerRuntime,
    filePath: string,
    version: string | undefined,
  ) {
    const { image } = yield* resolveArtifact({
      service: "storage",
      ...(version === undefined ? {} : { version }),
    });
    yield* container.prepare(image);
    const probeFile = `.supabase-xattr-probe-${yield* crypto.randomUUIDv4}`;
    const [stdout, stderr, code] = yield* Effect.scoped(
      container
        .launchCommand({
          image,
          stackId: options.stackId,
          instanceId: options.instanceId,
          service: "storage",
          ...(options.project === undefined ? {} : { project: options.project }),
          env: { PROBE_FILE: probeFile },
          entrypoint: "/slim-runtime/node/bin/node",
          args: ["-e", xattrProbe],
          mounts: [{ source: filePath, target: "/probe", readOnly: false }],
        })
        .pipe(
          Effect.catchTag("ContainerLaunchError", (error) => Effect.fail(error.failure)),
          Effect.mapError(
            (cause) =>
              new ServiceError({
                operation: "launch",
                message: `Unable to check whether the Storage uploads directory ${filePath} keeps extended attributes: ${cause.message}`,
                cause,
              }),
          ),
          Effect.flatMap((process) =>
            Effect.all(
              [
                process.stdout.pipe(Stream.decodeText, Stream.mkString),
                process.stderr.pipe(Stream.decodeText, Stream.mkString),
                process.exitCode,
              ],
              { concurrency: "unbounded" },
            ),
          ),
        ),
    ).pipe(
      Effect.ensuring(
        fs.remove(path.join(filePath, probeFile), { force: true }).pipe(Effect.ignore),
      ),
      Effect.timeout("1 minute"),
      Effect.mapError((cause) =>
        Cause.isTimeoutError(cause)
          ? new ServiceError({
              operation: "launch",
              message: `Timed out checking whether the Storage uploads directory ${filePath} keeps extended attributes`,
            })
          : cause,
      ),
    );
    const answer = stdout.trim();
    if (code === 0 && (answer === "supported" || answer === "read-only")) return true;
    if (code === 0 && answer === "unsupported") return false;
    return yield* new ServiceError({
      operation: "launch",
      message: `Unable to check whether the Storage uploads directory ${filePath} keeps extended attributes: ${stderr.trim() || `probe exited with ${code}`}`,
    });
  });
  const uploads: UploadsMount = ({ filePath, readOnly, version }) =>
    Effect.gen(function* () {
      const container = options.container;
      if (container === undefined)
        return yield* new ServiceError({
          operation: "launch",
          message: "Storage uploads mount requires a container runtime",
        });
      const known = (yield* Ref.get(answers)).get(filePath);
      // TODO(STORAGE-825): keep the existing-volume check without the probe, or uploads in it 404.
      const bind =
        known ??
        (!(yield* container.stackVolumeExists({ stackId: options.stackId, source: filePath })) &&
          (yield* keepsBindMount(container, filePath, version)));
      if (known === undefined)
        yield* Ref.update(answers, (current) => new Map(current).set(filePath, bind));
      const mount: ContainerMount = bind
        ? { source: filePath, target: "/mnt", readOnly }
        : { type: "stack-volume", source: filePath, target: "/mnt", readOnly };
      return mount;
    }).pipe(Effect.mapError((cause) => mapToServiceError("launch", cause)));
  return uploads;
});

/** Fails launches that need `/mnt` when no container resolver was supplied. */
export const missingUploadsMount: UploadsMount = () =>
  Effect.fail(
    new ServiceError({ operation: "launch", message: "Storage uploads mount is not configured" }),
  );

export const makeSpec = (uploads = missingUploadsMount): ProcessRecipeSpec<Creation> => ({
  service: "storage",
  executable: "bin/storage",
  ports: { http: 5000 },
  healthPath: "/status",
  env: (creation, endpoints, container) =>
    Effect.gen(function* () {
      const http = endpoints.get("http");
      const databaseUrl = yield* requiredInput(
        "storage",
        "databaseUrl",
        creation.config.databaseUrl,
      );
      const db = yield* databaseConnection(databaseUrl);
      const jwt = creation.config.jwtSecret ?? localJwtSecret;
      const anon = yield* serviceJwt("anon", jwt);
      const service = yield* serviceJwt("service_role", jwt);
      const filePath = container ? "/mnt" : creation.config.filePath;
      return {
        DATABASE_URL: databaseUrl,
        ...(http === undefined ? {} : { STORAGE_PORT: String(http.port), PORT: String(http.port) }),
        ANON_KEY: creation.config.anonKey ?? anon,
        SERVICE_KEY: creation.config.serviceRoleKey ?? service,
        AUTH_JWT_SECRET: jwt,
        PGRST_JWT_SECRET: jwt,
        ...(creation.config.jwks === undefined ? {} : { JWT_JWKS: creation.config.jwks }),
        TENANT_ID: "stub",
        REGION: "local",
        GLOBAL_S3_BUCKET: "stub",
        STORAGE_BACKEND: "file",
        DB_HOST: db.host,
        DB_PORT: db.port,
        DB_USER: db.username ?? "supabase_admin",
        DB_PASSWORD: db.password ?? "postgres",
        DB_NAME: db.database,
        FILE_STORAGE_BACKEND_PATH: filePath,
        STORAGE_FILE_BACKEND_PATH: filePath,
        ...(creation.config.s3ProtocolEnabled === undefined
          ? {}
          : { S3_PROTOCOL_ENABLED: String(creation.config.s3ProtocolEnabled) }),
        ...(creation.config.vectorEnabled === undefined
          ? {}
          : { VECTOR_ENABLED: String(creation.config.vectorEnabled) }),
        ...(creation.config.vectorEnabled !== true
          ? {}
          : {
              VECTOR_BUCKET_PROVIDER: "pgvector",
              VECTOR_STORE_MIGRATIONS_ENABLED: "true",
              VECTOR_DATABASE_URL: creation.config.vectorDatabaseUrl ?? databaseUrl,
            }),
        ...(creation.config.vectorMaxBuckets === undefined
          ? {}
          : { VECTOR_MAX_BUCKETS: String(creation.config.vectorMaxBuckets) }),
        ...(creation.config.vectorMaxIndexes === undefined
          ? {}
          : { VECTOR_MAX_INDEXES: String(creation.config.vectorMaxIndexes) }),
        ...(creation.config.fileSizeLimit === undefined
          ? {}
          : { FILE_SIZE_LIMIT: creation.config.fileSizeLimit }),
        ...(creation.config.imgproxyUrl === undefined
          ? {}
          : {
              IMGPROXY_URL: creation.config.imgproxyUrl,
              ENABLE_IMAGE_TRANSFORMATION: "true",
            }),
      };
    }),
  args: () => Effect.succeed([]),
  mounts: (creation) =>
    uploads({
      filePath: creation.config.filePath,
      readOnly: false,
      ...(creation.version === undefined ? {} : { version: creation.version }),
    }).pipe(Effect.map((mount) => [mount])),
  startupCommands: [initializationCommand],
});
