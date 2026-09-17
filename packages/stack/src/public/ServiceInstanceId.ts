import { Schema } from "effect";

declare const ServiceInstanceIdTypeId: unique symbol;

/** Immutable identity for one registered service instance. */
export type ServiceInstanceId = string & {
  readonly [ServiceInstanceIdTypeId]: "ServiceInstanceId";
};

const SERVICE_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const isServiceInstanceId = (value: string): value is ServiceInstanceId =>
  SERVICE_INSTANCE_ID.test(value);

export const ServiceInstanceIdSchema = Schema.String.pipe(
  Schema.refine((value): value is ServiceInstanceId => isServiceInstanceId(value), {
    identifier: "ServiceInstanceId",
    message: "Expected a non-empty service instance identifier",
  }),
);
