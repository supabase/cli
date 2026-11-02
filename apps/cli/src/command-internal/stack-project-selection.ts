import {
  readSelectionBundlingStale,
  readSelectionOrBundled,
  type LockRequest,
} from "./stack-lock.ts";

/** The pins the project's lock selects for a request; an applied `[remotes.<ref>]` block can make entries stale, which then take their bundled pins. */
export const selectionForRequest = ({
  appliedRemote,
  ...request
}: LockRequest & { readonly appliedRemote: string | undefined }) =>
  appliedRemote === undefined
    ? readSelectionOrBundled(request)
    : readSelectionBundlingStale(request);
