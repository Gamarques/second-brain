import { z } from "zod";

import {
  environmentConfigurationCatalog,
  environmentServiceRestartTargets,
  type EnvironmentConfigurationManager,
  type StageEnvironmentConfigurationInput,
} from "@second-brain/engine/environment-configuration";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import { AdminRevisionConflictError } from "../domain.js";
import {
  adminChannelAccess,
  requireAdminAccess,
} from "./admin-access.js";
import { defineCapability } from "@second-brain/engine/capabilities/define";
import { idempotencyKeySchema, timestampSchema } from "@second-brain/engine/capabilities/schemas";

const editableNameSchema = z.enum(
  environmentConfigurationCatalog.map(({ name }) => name),
);

const variableSchema = z.discriminatedUnion("secret", [
  z.object({
    name: editableNameSchema,
    secret: z.literal(true),
    configured: z.boolean(),
    restartRequired: z.literal(true),
  }),
  z.object({
    name: editableNameSchema,
    secret: z.literal(false),
    configured: z.boolean(),
    value: z.string().nullable(),
    restartRequired: z.literal(true),
  }),
]);

const listedConfigurationSchema = z.object({
  revision: z.number().int().nonnegative(),
  restartRequired: z.boolean(),
  updatedAt: timestampSchema.nullable(),
  variables: z.array(variableSchema).max(environmentConfigurationCatalog.length),
});

const changeSchema = z.discriminatedUnion("operation", [
  z.object({
    name: editableNameSchema,
    operation: z.literal("set"),
    value: z.string().min(1).max(4_096),
  }),
  z.object({
    name: editableNameSchema,
    operation: z.literal("clear"),
  }),
]);

const updateSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: idempotencyKeySchema,
  changes: z.array(changeSchema).min(1).max(environmentConfigurationCatalog.length),
});

const stagedConfigurationSchema = z.object({
  revision: z.number().int().positive(),
  changedNames: z.array(editableNameSchema).min(1).max(environmentConfigurationCatalog.length),
  restartRequired: z.literal(true),
  updatedAt: timestampSchema.nullable(),
  replayed: z.boolean(),
});

const restartSchema = z.object({
  expectedRevision: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
});

const restartResultSchema = z.object({
  revision: z.number().int().positive(),
  targets: z.tuple([
    z.literal(environmentServiceRestartTargets[0]),
    z.literal(environmentServiceRestartTargets[1]),
    z.literal(environmentServiceRestartTargets[2]),
  ]),
  requestedAt: timestampSchema,
  replayed: z.boolean(),
});

const readAnnotations = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
} as const;

const mutationAnnotations = {
  readOnly: false,
  destructive: false,
  idempotent: true,
  openWorld: false,
} as const;

function managerInput(
  input: z.output<typeof updateSchema>,
): StageEnvironmentConfigurationInput {
  return input;
}

export function createAdminEnvironmentCapabilities(
  accessStore: BrainAccessStore,
  configuration: EnvironmentConfigurationManager,
) {
  const listVariables = defineCapability({
    title: "List environment variables",
    description:
      "Lists the fixed administrative environment catalog and staged state without returning secret values.",
    input: z.object({}),
    output: listedConfigurationSchema,
    access: adminChannelAccess,
    timeoutMs: 10_000,
    annotations: readAnnotations,
    async run({ input, context }) {
      const access = await requireAdminAccess(accessStore, context, "admin");
      return listedConfigurationSchema.parse(
        await configuration.list(access, context.signal),
      );
    },
  });

  const updateVariables = defineCapability({
    title: "Update environment variables",
    description:
      "Revision-stages allowlisted restart-required environment changes; it never applies host or Docker changes.",
    input: updateSchema,
    output: stagedConfigurationSchema,
    access: adminChannelAccess,
    timeoutMs: 10_000,
    annotations: mutationAnnotations,
    async run({ input, context }) {
      const access = await requireAdminAccess(accessStore, context, "owner");
      const result = await configuration.stage(
        access,
        managerInput(input),
        context.signal,
      );
      if (result === null) throw new AdminRevisionConflictError();
      return stagedConfigurationSchema.parse(result);
    },
  });

  const restartServices = defineCapability({
    title: "Restart configuration services",
    description:
      "Durably requests a graceful restart of the supervised runtimes that consume environment configuration.",
    input: restartSchema,
    output: restartResultSchema,
    access: adminChannelAccess,
    timeoutMs: 10_000,
    annotations: mutationAnnotations,
    async run({ input, context }) {
      const access = await requireAdminAccess(accessStore, context, "owner");
      const result = await configuration.restart(access, input, context.signal);
      if (result === null) throw new AdminRevisionConflictError();
      return restartResultSchema.parse(result);
    },
  });

  return {
    admin_environment_variables_list: listVariables,
    admin_environment_variables_update: updateVariables,
    admin_environment_services_restart: restartServices,
  } as const;
}
