// Vitest evaluates global setup separately from test modules. Keep this module
// side-effect-free so global setup can provide the shared state root.
export {};

declare module "vitest" {
  export interface ProvidedContext {
    stackStateRoot: string;
  }
}
