import { createAdminNotificationCapabilities } from "./capabilities/admin-notifications.js";
import type { NotificationAdminStore } from "@second-brain/engine/domain/notifications";
import { createAdminBriefingCapabilities } from "./capabilities/admin-briefing.js";
import type { BriefingStore } from "@second-brain/engine/domain/briefing";
import { createAdminProjectCapabilities } from "./capabilities/admin-projects.js";
import { createAdminQuestionCapabilities } from "./capabilities/admin-question.js";
import type { ProjectOverviewStore } from "@second-brain/engine/domain/project-overview";
import type { BrainQuestionService } from "@second-brain/engine/domain/brain-question";
import { createAdminLearningCapabilities } from "./capabilities/admin-learning.js";
import type { LearningReviewStore } from "@second-brain/engine/domain/learning-review";
import { createAdminDreamingCapabilities } from "./capabilities/admin-dreaming.js";
import type { AdminDreamingStore } from "./dreaming-domain.js";
import { createAdminModelCapabilities } from "./capabilities/admin-models.js";
import type { ModelConfigurationService } from "@second-brain/engine/providers/model-configuration";
import type { DrizzleModelUsageStore } from "@second-brain/engine/database/stores/model-usage-store";
import { createEngine, type ExecutionSource } from "@invokta/core";

import { createAdminAuditCapabilities } from "./capabilities/admin-audit.js";
import { createAdminBrainMapCapabilities } from "./capabilities/admin-brain-map.js";
import { adminExecutionSource } from "./capabilities/admin-access.js";
import { createAdminAutomationCapabilities } from "./capabilities/admin-automation.js";
import { createAdminEnvironmentCapabilities } from "./capabilities/admin-environment.js";
import type { EnvironmentConfigurationManager } from "@second-brain/engine/environment-configuration";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import type {
  AdminAuditStore,
  AdminAutomationStore,
  AdminBrainMapStore,
} from "./domain.js";
import { SECOND_BRAIN_VERSION } from "@second-brain/engine/version";

export interface SecondBrainAdminEngineDependencies {
  readonly access: BrainAccessStore;
  readonly automation: AdminAutomationStore;
  readonly dreaming: AdminDreamingStore;
  readonly learning: LearningReviewStore;
  readonly projectOverview: ProjectOverviewStore;
  readonly questions: BrainQuestionService;
  readonly briefing: BriefingStore;
  readonly notifications: NotificationAdminStore;
  readonly audit: AdminAuditStore;
  readonly brainMap: AdminBrainMapStore;
  readonly models: ModelConfigurationService;
  readonly modelUsage: Pick<DrizzleModelUsageStore, "summary" | "runtimes">;
  readonly configuration: EnvironmentConfigurationManager;
}

/**
 * Composes the private administrative catalog without changing the public MCP
 * engine. Its invocation wrapper supplies the private channel marker, so a
 * transport cannot accidentally downgrade an admin request to trusted direct.
 */
export function createSecondBrainAdminEngine(
  dependencies: SecondBrainAdminEngineDependencies,
) {
  const automation = createAdminAutomationCapabilities(
    dependencies.access,
    dependencies.automation,
  );
  const audit = createAdminAuditCapabilities(
    dependencies.access,
    dependencies.audit,
  );
  const brainMap = createAdminBrainMapCapabilities(
    dependencies.access,
    dependencies.brainMap,
  );
  const environment = createAdminEnvironmentCapabilities(
    dependencies.access,
    dependencies.configuration,
  );
  const notifications = createAdminNotificationCapabilities(dependencies.access, dependencies.notifications);
  const briefing = createAdminBriefingCapabilities(dependencies.access, dependencies.briefing);
  const projectOverview = createAdminProjectCapabilities(dependencies.access, dependencies.projectOverview);
  const questions = createAdminQuestionCapabilities(dependencies.access, dependencies.questions);
  const learning = createAdminLearningCapabilities(dependencies.access, dependencies.learning);
  const dreaming = createAdminDreamingCapabilities(dependencies.access, dependencies.dreaming);
  const models = createAdminModelCapabilities(dependencies.access, dependencies.models, dependencies.modelUsage);
  const engine = createEngine({
    name: "second-brain-admin",
    version: SECOND_BRAIN_VERSION,
    capabilities: {
      ...notifications,
      admin_briefing_get: briefing.admin_briefing_get,
      admin_briefing_act: briefing.admin_briefing_act,
      admin_project_get: projectOverview.admin_project_get,
      admin_project_section: projectOverview.admin_project_section,
      admin_brain_question: questions.admin_brain_question,
      admin_learning_list: learning.admin_learning_list,
      admin_learning_dreaming_get: learning.admin_learning_dreaming_get,
      admin_learning_dreaming_review: learning.admin_learning_dreaming_review,
      admin_dreaming_calendar_get: dreaming.admin_dreaming_calendar_get,
      admin_dreaming_retry: dreaming.admin_dreaming_retry,
      admin_model_configuration_get: models.admin_model_configuration_get,
      admin_model_catalog_list: models.admin_model_catalog_list,
      admin_model_probe: models.admin_model_probe,
      admin_model_usage_get: models.admin_model_usage_get,
      admin_automation_settings_get:
        automation.admin_automation_settings_get,
      admin_automation_settings_update:
        automation.admin_automation_settings_update,
      admin_automation_status_get: automation.admin_automation_status_get,
      admin_automation_jobs_list: automation.admin_automation_jobs_list,
      admin_dreaming_runs_create: automation.admin_dreaming_runs_create,
      admin_audit_events_list: audit.admin_audit_events_list,
      admin_brain_map_get: brainMap.admin_brain_map_get,
      admin_environment_variables_list:
        environment.admin_environment_variables_list,
      admin_environment_variables_update:
        environment.admin_environment_variables_update,
      admin_environment_services_restart:
        environment.admin_environment_services_restart,
    },
  });

  const invoke: typeof engine.invoke = (capabilityId, input, options) =>
    engine.invoke(capabilityId, input, {
      ...options,
      // Invokta 0.6 has no typed extension point for private sources, but it
      // faithfully preserves the runtime value in the execution context.
      source: adminExecutionSource as ExecutionSource,
    });

  return {
    name: engine.name,
    version: engine.version,
    invoke,
    list: engine.list,
    describe: engine.describe,
  };
}
