export * from "./briefing.js";
import * as briefing from "./briefing.js";
export * from "./learning-review.js";
import * as learningReview from "./learning-review.js";
export * from "./model-usage.js";
import * as modelUsage from "./model-usage.js";
export * from "./admin.js";
export * from "./automation.js";
export * from "./brain-pack.js";
export * from "./common.js";
export * from "./content.js";
export * from "./context.js";
export * from "./dreaming.js";
export * from "./embeddings.js";
export * from "./identity.js";
export * from "./ingestion.js";
export * from "./temporal.js";

import * as admin from "./admin.js";
import * as automation from "./automation.js";
import * as brainPack from "./brain-pack.js";
import * as content from "./content.js";
import * as context from "./context.js";
import * as dreaming from "./dreaming.js";
import * as embeddings from "./embeddings.js";
import * as identity from "./identity.js";
import * as ingestion from "./ingestion.js";
import * as temporal from "./temporal.js";

export const schema = {
  ...briefing,
  ...learningReview,
  ...modelUsage,
  ...admin,
  ...identity,
  ...content,
  ...embeddings,
  ...temporal,
  ...ingestion,
  ...automation,
  ...dreaming,
  ...context,
  ...brainPack,
};
