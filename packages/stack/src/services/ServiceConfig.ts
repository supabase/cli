import { Effect } from "effect";
import { SignJWT } from "jose";
import { ServiceError } from "../Service.ts";

const serviceError = (operation: string, cause: unknown): ServiceError =>
  cause instanceof ServiceError
    ? cause
    : new ServiceError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

export const localJwtSecret = "supabase-local-development-jwt-secret";

export const serviceJwt = Effect.fn("ServiceConfig.serviceJwt")(
  (role: string, secret: string): Effect.Effect<string, ServiceError> =>
    Effect.tryPromise(() =>
      new SignJWT({ role, aud: "authenticated" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .sign(new TextEncoder().encode(secret)),
    ).pipe(Effect.mapError((cause) => serviceError("launch", cause))),
);

export const databaseConnection = Effect.fn("ServiceConfig.databaseConnection")(
  (
    value: string,
  ): Effect.Effect<
    Readonly<{
      readonly host: string;
      readonly port: string;
      readonly database: string;
      readonly username: string | undefined;
      readonly password: string | undefined;
    }>,
    ServiceError
  > =>
    Effect.try({
      try: () => {
        const url = new URL(value);
        return {
          host: url.hostname || "127.0.0.1",
          port: url.port || "5432",
          database: url.pathname.replace(/^\//u, "") || "postgres",
          username: url.username === "" ? undefined : decodeURIComponent(url.username),
          password: url.password === "" ? undefined : decodeURIComponent(url.password),
        };
      },
      catch: (cause) => serviceError("launch", cause),
    }),
);
