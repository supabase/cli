import { afterEach, describe, expect, test, vi } from "vitest";

import {
  legacyAppendStorageVectorEnv,
  legacyBuildStorageContainerSpec,
  legacyBuildStorageEnv,
  type LegacyStorageContainerSpecInput,
  type LegacyStorageEnvInput,
} from "./storage.service.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const baseEnvInput: LegacyStorageEnvInput = {
  targetMigration: "",
  anonKey: "anon-key",
  serviceRoleKey: "service-role-key",
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwks: '{"keys":[]}',
  dbHost: "supabase_db_proj",
  dbPassword: "postgres",
  fileSizeLimit: "50MiB",
  s3Region: "local",
  s3AccessKeyId: "625729a08b95bf1b7ff351a663f3a23c",
  s3SecretAccessKey: "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
  imageTransformationEnabled: false,
  imgproxyHost: "supabase_imgproxy_proj",
  s3ProtocolEnabled: true,
  vectorBucketsEnabled: false,
};

describe("legacyBuildStorageEnv", () => {
  test("wires the resolved auth keys, JWT secret, and JWKS", () => {
    const env = legacyBuildStorageEnv(baseEnvInput);
    expect(env["ANON_KEY"]).toBe("anon-key");
    expect(env["SERVICE_KEY"]).toBe("service-role-key");
    expect(env["AUTH_JWT_SECRET"]).toBe(baseEnvInput.jwtSecret);
    expect(env["JWT_JWKS"]).toBe(baseEnvInput.jwks);
  });

  test("wires DATABASE_URL as the supabase_storage_admin role against the internal DB address", () => {
    const env = legacyBuildStorageEnv(baseEnvInput);
    expect(env["DATABASE_URL"]).toBe(
      "postgresql://supabase_storage_admin:postgres@supabase_db_proj:5432/postgres",
    );
  });

  test("wires the resolved S3 credentials, not hardcoded literals", () => {
    const env = legacyBuildStorageEnv({
      ...baseEnvInput,
      s3AccessKeyId: "custom-access-key",
      s3SecretAccessKey: "custom-secret-key",
      s3Region: "custom-region",
    });
    expect(env["S3_PROTOCOL_ACCESS_KEY_ID"]).toBe("custom-access-key");
    expect(env["S3_PROTOCOL_ACCESS_KEY_SECRET"]).toBe("custom-secret-key");
    expect(env["STORAGE_S3_REGION"]).toBe("custom-region");
  });

  test("converts file_size_limit from a human-readable string to a byte count", () => {
    const env = legacyBuildStorageEnv({ ...baseEnvInput, fileSizeLimit: "5MiB" });
    expect(env["FILE_SIZE_LIMIT"]).toBe(String(5 * 1024 * 1024));
  });

  test("matches Go's remaining static env values", () => {
    const env = legacyBuildStorageEnv(baseEnvInput);
    expect(env).toMatchObject({
      STORAGE_BACKEND: "file",
      FILE_STORAGE_BACKEND_PATH: "/mnt",
      TENANT_ID: "stub",
      GLOBAL_S3_BUCKET: "stub",
      TUS_URL_PATH: "/storage/v1/upload/resumable",
      S3_PROTOCOL_PREFIX: "/storage/v1",
      UPLOAD_FILE_SIZE_LIMIT: "52428800000",
      UPLOAD_FILE_SIZE_LIMIT_STANDARD: "5242880000",
      SIGNED_UPLOAD_URL_EXPIRATION_TIME: "7200",
    });
  });

  describe("image-transformation / ImgProxy gate", () => {
    test("ENABLE_IMAGE_TRANSFORMATION and IMGPROXY_URL reflect the caller-resolved compound flag", () => {
      const disabled = legacyBuildStorageEnv({
        ...baseEnvInput,
        imageTransformationEnabled: false,
      });
      expect(disabled["ENABLE_IMAGE_TRANSFORMATION"]).toBe("false");

      const enabled = legacyBuildStorageEnv({ ...baseEnvInput, imageTransformationEnabled: true });
      expect(enabled["ENABLE_IMAGE_TRANSFORMATION"]).toBe("true");
    });

    test("IMGPROXY_URL always points at the imgproxy container regardless of the gate", () => {
      const env = legacyBuildStorageEnv(baseEnvInput);
      expect(env["IMGPROXY_URL"]).toBe("http://supabase_imgproxy_proj:5001");
    });
  });

  describe("S3 protocol gate", () => {
    test("S3_PROTOCOL_ENABLED reflects config.storage.s3_protocol.enabled directly", () => {
      expect(
        legacyBuildStorageEnv({ ...baseEnvInput, s3ProtocolEnabled: true })["S3_PROTOCOL_ENABLED"],
      ).toBe("true");
      expect(
        legacyBuildStorageEnv({ ...baseEnvInput, s3ProtocolEnabled: false })["S3_PROTOCOL_ENABLED"],
      ).toBe("false");
    });
  });

  describe("vector-buckets env branch", () => {
    test("omits every VECTOR_* key when vectorBucketsEnabled is false", () => {
      const env = legacyBuildStorageEnv({ ...baseEnvInput, vectorBucketsEnabled: false });
      expect(env["VECTOR_ENABLED"]).toBeUndefined();
      expect(env["VECTOR_BUCKET_PROVIDER"]).toBeUndefined();
      expect(env["VECTOR_STORE_MIGRATIONS_ENABLED"]).toBeUndefined();
      expect(env["VECTOR_DATABASE_URL"]).toBeUndefined();
    });

    test("appends the four VECTOR_* keys with Go's defaults when enabled and no override is set", () => {
      const env = legacyBuildStorageEnv({ ...baseEnvInput, vectorBucketsEnabled: true });
      expect(env["VECTOR_ENABLED"]).toBe("true");
      expect(env["VECTOR_BUCKET_PROVIDER"]).toBe("pgvector");
      expect(env["VECTOR_STORE_MIGRATIONS_ENABLED"]).toBe("true");
      expect(env["VECTOR_DATABASE_URL"]).toBe(
        "postgresql://postgres:postgres@supabase_db_proj:5432/postgres",
      );
    });

    test("VECTOR_DATABASE_URL defaults to the postgres role, distinct from DATABASE_URL's storage_admin role", () => {
      const env = legacyBuildStorageEnv({ ...baseEnvInput, vectorBucketsEnabled: true });
      expect(env["VECTOR_DATABASE_URL"]).not.toBe(env["DATABASE_URL"]);
      expect(env["VECTOR_DATABASE_URL"]).toContain("postgres:postgres@");
      expect(env["DATABASE_URL"]).toContain("supabase_storage_admin:postgres@");
    });

    test("respects a projectEnvValues override over the default, matching Go's envOrDefault", () => {
      const env = legacyBuildStorageEnv({
        ...baseEnvInput,
        vectorBucketsEnabled: true,
        projectEnvValues: { VECTOR_ENABLED: "false", VECTOR_BUCKET_PROVIDER: "custom" },
      });
      expect(env["VECTOR_ENABLED"]).toBe("false");
      expect(env["VECTOR_BUCKET_PROVIDER"]).toBe("custom");
      // Unoverridden keys still fall back to the defaults.
      expect(env["VECTOR_STORE_MIGRATIONS_ENABLED"]).toBe("true");
    });

    test("an override that is set but empty is used verbatim, matching os.LookupEnv (not treated as unset)", () => {
      const env = legacyBuildStorageEnv({
        ...baseEnvInput,
        vectorBucketsEnabled: true,
        projectEnvValues: { VECTOR_BUCKET_PROVIDER: "" },
      });
      expect(env["VECTOR_BUCKET_PROVIDER"]).toBe("");
    });
  });
});

describe("legacyAppendStorageVectorEnv", () => {
  test("preserves the base env and appends the four vector keys", () => {
    const base = { EXISTING_KEY: "unchanged" };
    const appended = legacyAppendStorageVectorEnv(base, {
      dbHost: "supabase_db_proj",
      dbPassword: "postgres",
    });
    expect(appended["EXISTING_KEY"]).toBe("unchanged");
    expect(Object.keys(appended)).toEqual(
      expect.arrayContaining([
        "VECTOR_ENABLED",
        "VECTOR_BUCKET_PROVIDER",
        "VECTOR_STORE_MIGRATIONS_ENABLED",
        "VECTOR_DATABASE_URL",
      ]),
    );
  });
});

describe("legacyBuildStorageContainerSpec", () => {
  const input: LegacyStorageContainerSpecInput = {
    projectId: "proj",
    networkId: "supabase_network_proj",
    image: "supabase/storage-api:v1",
    targetMigration: "",
    fileSizeLimit: "50MiB",
    s3Region: "local",
    s3AccessKeyId: "625729a08b95bf1b7ff351a663f3a23c",
    s3SecretAccessKey: "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
    s3ProtocolEnabled: true,
    imageTransformationEnabled: false,
    vectorBucketsEnabled: false,
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwks: '{"keys":[]}',
    anonKey: "anon-key",
    serviceRoleKey: "service-role-key",
  };

  test("derives the container name, DB host, and imgproxy host from projectId", () => {
    const spec = legacyBuildStorageContainerSpec(input);
    expect(spec.containerName).toBe("supabase_storage_proj");
    expect(spec.env["DATABASE_URL"]).toBe(
      "postgresql://supabase_storage_admin:postgres@supabase_db_proj:5432/postgres",
    );
    expect(spec.env["IMGPROXY_URL"]).toBe("http://supabase_imgproxy_proj:5001");
  });

  test("mounts its own named volume at /mnt, with no ports/exposedPorts", () => {
    const spec = legacyBuildStorageContainerSpec(input);
    expect(spec.binds).toEqual(["supabase_storage_proj:/mnt"]);
    expect(spec.ports).toBeUndefined();
    expect(spec.exposedPorts).toBeUndefined();
  });

  test("builds the wget-based healthcheck against the IPv4 loopback", () => {
    const spec = legacyBuildStorageContainerSpec(input);
    expect(spec.healthcheck).toEqual({
      test: [
        "CMD",
        "wget",
        "--no-verbose",
        "--tries=1",
        "--spider",
        "http://127.0.0.1:5000/status",
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    });
  });

  test("network alias is 'storage'", () => {
    const spec = legacyBuildStorageContainerSpec(input);
    expect(spec.networkAliases).toEqual(["storage"]);
    expect(spec.networkId).toBe("supabase_network_proj");
    expect(spec.restartPolicy).toBe("unless-stopped");
    expect(spec.labels).toEqual({});
  });

  test("propagates the image-transformation gate through to ENABLE_IMAGE_TRANSFORMATION", () => {
    const withImgproxy = legacyBuildStorageContainerSpec({
      ...input,
      imageTransformationEnabled: true,
    });
    expect(withImgproxy.env["ENABLE_IMAGE_TRANSFORMATION"]).toBe("true");

    const withoutImgproxy = legacyBuildStorageContainerSpec({
      ...input,
      imageTransformationEnabled: false,
    });
    expect(withoutImgproxy.env["ENABLE_IMAGE_TRANSFORMATION"]).toBe("false");
  });

  test("propagates the vector-buckets flag through to the container env", () => {
    const spec = legacyBuildStorageContainerSpec({ ...input, vectorBucketsEnabled: true });
    expect(spec.env["VECTOR_ENABLED"]).toBe("true");
    expect(spec.env["VECTOR_DATABASE_URL"]).toBe(
      "postgresql://postgres:postgres@supabase_db_proj:5432/postgres",
    );
  });

  test("omits the Docker healthcheck on a slim distroless storage image", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const spec = legacyBuildStorageContainerSpec({
      ...input,
      image: "ghcr.io/supabase/cli/storage:v1.70.3",
    });
    expect(spec.healthcheck).toBeUndefined();
  });

  test("mounts the named volume at /home/nonroot on a slim image so uid 65532 can mkdir the tenant dir", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const spec = legacyBuildStorageContainerSpec({
      ...input,
      image: "ghcr.io/supabase/cli/storage:v1.70.3",
    });
    expect(spec.binds).toEqual(["supabase_storage_proj:/home/nonroot"]);
    expect(spec.env["FILE_STORAGE_BACKEND_PATH"]).toBe("/home/nonroot");
  });
});
