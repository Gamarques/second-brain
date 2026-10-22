import {
  defineCapability as defineInvoktaCapability,
  type CapabilityDefinition,
} from "@invokta/core";
import { z } from "zod";

function rejectsRemovedBrainSelection<InputSchema extends z.ZodType>(
  schema: InputSchema,
): InputSchema {
  const guarded = z.preprocess((value, context) => {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "brainId")
    ) {
      context.addIssue({
        code: "custom",
        message: "brainId is not supported by this single-brain deployment.",
        path: ["brainId"],
      });
    }
    return value;
  }, schema);
  // The preprocessing guard does not transform successful values, so its
  // validated input type is exactly the wrapped capability schema's type.
  return guarded as unknown as InputSchema;
}

/** Defines a public capability while rejecting the removed tenant selector. */
export function defineCapability<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
>(definition: CapabilityDefinition<InputSchema, OutputSchema>) {
  return defineInvoktaCapability({
    ...definition,
    input: rejectsRemovedBrainSelection(definition.input),
  });
}
