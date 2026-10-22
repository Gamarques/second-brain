import calibrationPrompt from "../content/agent-resources/knowledge-calibration.md?raw";
import mcpPrompt from "../content/agent-resources/mcp-instructions.md?raw";
import mcpSkill from "../content/agent-resources/second-brain-mcp/SKILL.md?raw";

export const agentResources = [
  {
    id: "skill",
    filename: "SKILL.md",
    content: mcpSkill,
    titleKey: "agentResources.skill.title",
    descriptionKey: "agentResources.skill.description",
    usageKey: "agentResources.skill.usage",
  },
  {
    id: "mcp-prompt",
    filename: "second-brain-mcp-prompt.md",
    content: mcpPrompt,
    titleKey: "agentResources.mcpPrompt.title",
    descriptionKey: "agentResources.mcpPrompt.description",
    usageKey: "agentResources.mcpPrompt.usage",
  },
  {
    id: "calibration",
    filename: "second-brain-knowledge-calibration.md",
    content: calibrationPrompt,
    titleKey: "agentResources.calibration.title",
    descriptionKey: "agentResources.calibration.description",
    usageKey: "agentResources.calibration.usage",
  },
] as const;
