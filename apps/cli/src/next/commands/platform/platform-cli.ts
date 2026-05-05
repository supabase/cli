import type { PlatformOperationDescriptor } from "./platform-types.ts";

export function normalizePlatformRoute(route: string): string {
  return route.startsWith("/") ? route : `/${route}`;
}

export function formatPlatformApiCommand(descriptor: PlatformOperationDescriptor): string {
  const methodFlag = descriptor.method === "GET" ? "" : ` --method ${descriptor.method}`;
  return `supabase api request ${descriptor.path}${methodFlag}`;
}

export function formatPlatformApiSchemaCommand(descriptor: PlatformOperationDescriptor): string {
  return `${formatPlatformApiCommand(descriptor)} --schema`;
}
