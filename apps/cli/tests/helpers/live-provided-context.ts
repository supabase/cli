// Vitest evaluates global setup separately from test modules. Keep this module
// side-effect-free so global setup can provide the shared live environment.
export {};

declare module "vitest" {
  export interface ProvidedContext {
    liveProject: {
      readonly ref: string;
      readonly dbUrl: string;
      readonly dbPassword: string;
      readonly anonKey: string;
      readonly serviceRoleKey: string;
      readonly functionsUrl: string;
      readonly storageBucket: string;
    };
    liveProfilePath: string;
  }
}
