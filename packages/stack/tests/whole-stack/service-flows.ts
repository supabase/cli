import { expect } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SignJWT } from "jose";
import { requestWithHeaders, service, type WholeStack } from "./fixture.ts";

const image = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAQUlEQVR4nBWLURUAQAiDlsQkS2ISkphkSUx0J5/wkEQJixaIERErJFPGpg1mTMz6B6gzNMdAYP+sUMGhc25CwoYHii4nYbjsDOUAAAAASUVORK5CYII=",
  ),
  (value) => value.charCodeAt(0),
);

const serviceToken = Effect.fn("WholeStack.serviceToken")((fixture: WholeStack) =>
  Effect.tryPromise(() =>
    new SignJWT({ role: "service_role" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("whole-stack-service")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(fixture.secret)),
  ),
);

const execute = Effect.fn("WholeStack.serviceFlowRequest")(
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return yield* client.execute(request);
    }),
);

export const exerciseStorageAndFunctions = Effect.fn("WholeStack.exerciseStorageAndFunctions")(
  (fixture: WholeStack, accessToken: string, rowId: string, expectedValue: string, phase: string) =>
    Effect.gen(function* () {
      const storageUrl = (yield* service(fixture, "storage").credentials()).url;
      const functionsUrl = (yield* service(fixture, "functions").credentials()).url;
      if (storageUrl === undefined || functionsUrl === undefined)
        return yield* Effect.die("Storage or Functions URL missing");
      const token = yield* serviceToken(fixture);
      const auth = {
        authorization: `Bearer ${token}`,
        apikey: token,
      };
      const bucketName = `whole-stack-${phase}`;
      const objectName = `${bucketName}/source.png`;
      const bucketRequest = yield* HttpClientRequest.bodyJson({ name: bucketName, public: true })(
        HttpClientRequest.setHeader(
          "apikey",
          auth.apikey,
        )(
          HttpClientRequest.setHeader(
            "authorization",
            auth.authorization,
          )(HttpClientRequest.post(`${storageUrl}/bucket`)),
        ),
      );
      const bucket = yield* execute(bucketRequest);
      if (bucket.status >= 400) return yield* Effect.die(`Storage bucket failed: ${bucket.status}`);
      const uploadRequest = HttpClientRequest.bodyUint8Array(
        HttpClientRequest.setHeader(
          "apikey",
          auth.apikey,
        )(
          HttpClientRequest.setHeader(
            "authorization",
            auth.authorization,
          )(HttpClientRequest.post(`${storageUrl}/object/${objectName}`)),
        ),
        image,
        "image/png",
      );
      const upload = yield* execute(uploadRequest);
      if (upload.status >= 400) return yield* Effect.die(`Storage upload failed: ${upload.status}`);
      const download = yield* execute(
        HttpClientRequest.get(`${storageUrl}/object/public/${objectName}`).pipe(
          HttpClientRequest.setHeader("authorization", auth.authorization),
          HttpClientRequest.setHeader("apikey", auth.apikey),
        ),
      );
      if (download.status !== 200)
        return yield* Effect.die(`Storage download failed: ${download.status}`);
      const downloaded = new Uint8Array(yield* download.arrayBuffer);
      if (
        downloaded.length !== image.length ||
        downloaded.some((value, index) => value !== image[index])
      )
        return yield* Effect.die("Storage download differs from uploaded bytes");
      const transformed = yield* execute(
        HttpClientRequest.get(
          `${storageUrl}/render/image/public/${objectName}?width=4&height=2&format=origin`,
        ).pipe(
          HttpClientRequest.setHeader("authorization", auth.authorization),
          HttpClientRequest.setHeader("apikey", auth.apikey),
        ),
      );
      if (transformed.status !== 200 || !transformed.headers["content-type"]?.includes("image/"))
        return yield* Effect.die(`Imgproxy transform failed: ${transformed.status}`);
      const transformedBytes = new Uint8Array(yield* transformed.arrayBuffer);
      const view = new DataView(
        transformedBytes.buffer,
        transformedBytes.byteOffset,
        transformedBytes.byteLength,
      );
      if (transformedBytes.length < 24 || view.getUint32(16) !== 4 || view.getUint32(20) !== 2)
        return yield* Effect.die("Imgproxy did not return a 4x2 PNG");
      const markerName = `${bucketName}/marker.txt`;
      const marker = new TextEncoder().encode(fixture.stack.id);
      const markerUpload = yield* execute(
        HttpClientRequest.bodyUint8Array(
          HttpClientRequest.setHeader(
            "apikey",
            auth.apikey,
          )(
            HttpClientRequest.setHeader(
              "authorization",
              auth.authorization,
            )(HttpClientRequest.post(`${storageUrl}/object/${markerName}`)),
          ),
          marker,
          "text/plain",
        ),
      );
      if (markerUpload.status >= 400)
        return yield* Effect.die(`Storage marker upload failed: ${markerUpload.status}`);
      const markerDownload = yield* execute(
        HttpClientRequest.get(`${storageUrl}/object/public/${markerName}`).pipe(
          HttpClientRequest.setHeader("authorization", auth.authorization),
          HttpClientRequest.setHeader("apikey", auth.apikey),
        ),
      );
      if (markerDownload.status !== 200 || (yield* markerDownload.text) !== fixture.stack.id)
        return yield* Effect.die("Storage marker differs from stack identity");
      const functionRequest = yield* HttpClientRequest.bodyJson({ id: rowId })(
        HttpClientRequest.setHeader(
          "content-type",
          "application/json",
        )(
          HttpClientRequest.setHeader(
            "authorization",
            `Bearer ${accessToken}`,
          )(HttpClientRequest.post(`${functionsUrl}/hello`)),
        ),
      );
      const functionResponse = yield* execute(functionRequest);
      if (functionResponse.status !== 200)
        return yield* Effect.die(
          `Function failed at ${functionsUrl}/hello: ${functionResponse.status}: ${yield* functionResponse.text}`,
        );
      const functionBody = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.String })),
        ),
      )(yield* functionResponse.text);
      if (
        functionBody.length !== 1 ||
        functionBody[0]?.id !== rowId ||
        functionBody[0]?.value !== expectedValue
      )
        return yield* Effect.die("Function did not return the managed REST row");
    }),
);

export const assertStoredImage = Effect.fn("WholeStack.assertStoredImage")(
  (fixture: WholeStack, phase: string) =>
    Effect.gen(function* () {
      const storageUrl = (yield* service(fixture, "storage").credentials()).url;
      if (storageUrl === undefined) return yield* Effect.die("Storage URL missing");
      const token = yield* serviceToken(fixture);
      const objectName = `whole-stack-${phase}/source.png`;
      const response = yield* execute(
        HttpClientRequest.get(`${storageUrl}/object/public/${objectName}`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
          HttpClientRequest.setHeader("apikey", token),
        ),
      );
      if (response.status !== 200)
        return yield* Effect.die(`Stored image read failed: ${response.status}`);
      const downloaded = new Uint8Array(yield* response.arrayBuffer);
      if (
        downloaded.length !== image.length ||
        downloaded.some((value, index) => value !== image[index])
      )
        return yield* Effect.die("Stored image differs from original bytes");
    }),
);

export const assertStoredMarker = Effect.fn("WholeStack.assertStoredMarker")(
  (fixture: WholeStack, phase: string) =>
    Effect.gen(function* () {
      const storageUrl = (yield* service(fixture, "storage").credentials()).url;
      if (storageUrl === undefined) return yield* Effect.die("Storage URL missing");
      const token = yield* serviceToken(fixture);
      const response = yield* execute(
        HttpClientRequest.get(`${storageUrl}/object/public/whole-stack-${phase}/marker.txt`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
          HttpClientRequest.setHeader("apikey", token),
        ),
      );
      if (response.status !== 200 || (yield* response.text) !== fixture.stack.id)
        return yield* Effect.die("Stored marker differs from stack identity");
    }),
);

export const exerciseMetadataAndPooler = Effect.fn("WholeStack.exerciseMetadataAndPooler")(
  (fixture: WholeStack, token: string, rowId: string, expectedValue: string) =>
    Effect.gen(function* () {
      const pgmetaUrl = (yield* service(fixture, "pgmeta").credentials()).url;
      const studioUrl = (yield* service(fixture, "studio").credentials()).url;
      const restUrl = (yield* service(fixture, "rest").credentials()).url;
      const databaseSql = (yield* service(fixture, "database").credentials({ from: "host" }))
        .databaseUrl;
      const poolerSql = (yield* service(fixture, "pooler").credentials()).sqlUrl;
      if (
        pgmetaUrl === undefined ||
        studioUrl === undefined ||
        restUrl === undefined ||
        databaseSql === undefined ||
        poolerSql === undefined
      )
        return yield* Effect.die("Metadata or Pooler credentials missing");
      const metadata = yield* execute(
        HttpClientRequest.get(`${pgmetaUrl}/tables?included_schemas=public`),
      );
      const metadataBody = yield* metadata.text;
      if (metadata.status !== 200 || !metadataBody.includes("whole_stack_items"))
        return yield* Effect.die(`Pgmeta did not return the fixture table: ${metadata.status}`);
      const studioRequest = HttpClientRequest.setHeader(
        "authorization",
        `Bearer ${token}`,
      )(HttpClientRequest.get(`${studioUrl}/api/platform/pg-meta/default/tables`));
      const studio = yield* execute(studioRequest);
      const studioBody = yield* studio.text;
      if (studio.status >= 400 || !studioBody.includes("whole_stack_items"))
        return yield* Effect.die(
          `Studio metadata did not return the fixture table: ${studio.status}: ${studioBody.slice(0, 1000)}`,
        );
      const databaseAddress = new URL(databaseSql);
      const databaseLayer = yield* Layer.build(
        PgClient.layer({
          host: databaseAddress.hostname,
          port: Number(databaseAddress.port),
          database: databaseAddress.pathname.slice(1) || "postgres",
          username: decodeURIComponent(databaseAddress.username) || "supabase_admin",
          password: Redacted.make(decodeURIComponent(databaseAddress.password) || "postgres"),
          connectTimeout: "120 seconds",
        }),
      );
      const database = Context.get(databaseLayer, PgClient.PgClient);
      const databaseRows =
        yield* database`select id, value from public.whole_stack_items where id = ${rowId}`;
      if (
        databaseRows.length !== 1 ||
        databaseRows[0]?.id !== rowId ||
        databaseRows[0]?.value !== expectedValue
      )
        return yield* Effect.die(
          `Public database SQL did not return the fixture row at ${databaseAddress.hostname}:${databaseAddress.port}/${databaseAddress.pathname}: rows=${databaseRows.map((row) => `${String(row.id)}=${String(row.value)}`).join(",")}`,
        );
      const poolerAddress = new URL(poolerSql);
      const poolerLayer = yield* Layer.build(
        PgClient.layer({
          host: poolerAddress.hostname,
          port: Number(poolerAddress.port),
          database: "postgres",
          username: "supabase_admin.whole",
          password: Redacted.make("postgres"),
          connectTimeout: "120 seconds",
        }),
      );
      const pooler = Context.get(poolerLayer, PgClient.PgClient);
      const poolerValue = `${expectedValue}-pooler`;
      yield* pooler`update public.whole_stack_items set value = ${poolerValue} where id = ${rowId}`;
      const rows =
        yield* pooler`select id, value from public.whole_stack_items where id = ${rowId}`;
      if (rows.length !== 1 || rows[0]?.id !== rowId || rows[0]?.value !== poolerValue)
        return yield* Effect.die("Pooler did not read back the fixture row");
      const rest = yield* requestWithHeaders(`${restUrl}/whole_stack_items?id=eq.${rowId}`, {
        authorization: `Bearer ${token}`,
        apikey: token,
      });
      expect(rest.status).toBe(200);
      const restRows = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.String })),
        ),
      )(rest.body);
      if (restRows.length !== 1 || restRows[0]?.id !== rowId || restRows[0]?.value !== poolerValue)
        return yield* Effect.die("REST did not observe the Pooler write");
    }),
);
