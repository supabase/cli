declare module "@parcel/watcher/wrapper" {
  export function createWrapper(binding: unknown): typeof import("@parcel/watcher");
}
