// Minimal ambient typings for the Deno-resolved jose import used by
// edge-runtime-main.ts. The bun workspace type-checker cannot resolve the
// `jsr:` specifier, so we describe only the surface that runtime script relies
// on; jose itself is loaded at runtime inside the edge runtime.
declare module "jsr:@panva/jose@6" {
  type JwksResolver = (...args: ReadonlyArray<unknown>) => Promise<CryptoKey>;
  export function decodeProtectedHeader(token: string): { readonly alg?: string };
  export function jwtVerify(jwt: string, key: Uint8Array | JwksResolver): Promise<unknown>;
  export function createLocalJWKSet(jwks: { readonly keys: ReadonlyArray<unknown> }): JwksResolver;
  export function createRemoteJWKSet(url: URL): JwksResolver;
}
