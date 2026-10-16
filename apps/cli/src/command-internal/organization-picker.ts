import { block } from "./command-permissions/model.ts";

/** The organization listing made when no organization ID is given, shared by `projects create` and `bootstrap`. */
export const organizationPicker = block("organization-picker", [
  {
    operationId: "v1-list-all-organizations",
    kind: "required",
    when: [{ flag: "org-id", present: false }],
  },
]);
