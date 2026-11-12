import { createHash, randomUUID } from 'node:crypto';
import { BadRequestError, ForbiddenError } from '../../../libs/errors/http.errors';
import { KeyValueStoreService } from '../../../libs/services/keyValueStore.service';
import { ProjectDto } from '../../projects/types/project.interfaces';
import { ProjectService } from '../../projects/services/project.service';
import { ProjectsFeature } from '../../projects/utils/projects-feature';
import { isUserOrgAdmin } from '../../user_management/services/user-admin.service';
import { AiModelsConfigRepository } from '../../configuration_manager/services/aiModelsConfig.repository';
import { getUserRepository } from '../../../libs/repositories/user';

export interface AgentProjectGrant {
  id: string;
  orgId: string;
  userId: string;
  agentId: string;
  projectId: string;
  fingerprint: string;
  approvedAt: number;
}

const key = (org: string, user: string, agent: string) => `/agent-project-grants/${org}/${user}/${agent}`;
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, item]) => [name, canonical(item)]));
  return value ?? null;
};

/** A human-owned read-only agent and the exact reviewed project scope. */
export function projectGrantPreview(agent: Record<string, unknown>, project: ProjectDto, configuredModels: unknown) {
  for (const field of ['toolsets', 'mcpServers', 'apiToolsetTools', 'skills']) {
    if (!Array.isArray(agent[field]) || (agent[field] as unknown[]).length) throw new ForbiddenError('Project schedules cannot use action tools, MCP servers or skills.');
  }
  if (!Array.isArray(agent.knowledge) || agent.mcpServersUnavailable || agent.isServiceAccount || agent.sendUserContext !== false || !agent.isActive) {
    throw new ForbiddenError('This agent is not eligible for a project schedule.');
  }
  const selected = Array.isArray(agent.models) ? agent.models[0] : undefined;
  if (!selected || typeof selected !== 'object' || typeof selected.modelKey !== 'string' || !selected.modelKey || typeof selected.modelName !== 'string' || !selected.modelName) {
    throw new ForbiddenError('Select a specific model before approving a project schedule.');
  }
  const llms = (configuredModels as { llm?: unknown })?.llm;
  const model = Array.isArray(llms) ? llms.find(item => item?.modelKey === selected.modelKey) : undefined;
  const names = typeof model?.configuration?.model === 'string' ? model.configuration.model.split(',').map((name: string) => name.trim()) : [];
  if (!model || typeof model.provider !== 'string' || !model.provider || !names.includes(selected.modelName) || (selected.provider && selected.provider !== model.provider)) {
    throw new ForbiddenError('The selected model configuration cannot be confirmed.');
  }
  const scope = project.knowledgeScope ?? {};
  if (typeof scope !== 'object' || Array.isArray(scope)) throw new ForbiddenError('The project source scope is invalid.');
  const sources = ['apps', 'kb', 'recordGroups', 'records'] as const;
  for (const name of sources) {
    const ids = scope[name];
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim()))) {
      throw new ForbiddenError('The project source scope is invalid.');
    }
  }
  if (!sources.some(name => (scope[name]?.length ?? 0) > 0) && !project.linkedKnowledgeBaseId) {
    throw new BadRequestError('The project has no explicitly scoped sources.');
  }
  const bound = {
    agent: Object.fromEntries(['knowledge', 'systemPrompt', 'instructions', 'models', 'defaultReasoningEffort', 'toolsets', 'mcpServers', 'apiToolsetTools', 'skills', 'sendUserContext', 'isServiceAccount', 'isActive'].map(name => [name, agent[name]])),
    project: { id: project._id, knowledgeScope: scope, linkedKnowledgeBaseId: project.linkedKnowledgeBaseId, instructions: project.instructions, tools: project.tools },
    model,
  };
  return {
    projectId: project._id,
    projectName: project.name,
    agentKnowledge: agent.knowledge,
    projectSources: scope,
    linkedKnowledgeBaseId: project.linkedKnowledgeBaseId ?? null,
    model: { modelKey: selected.modelKey, modelName: selected.modelName, provider: model.provider },
    modelFingerprint: createHash('sha256').update(JSON.stringify(canonical(model))).digest('hex'),
    fingerprint: createHash('sha256').update(JSON.stringify(canonical(bound))).digest('hex'),
  };
}

export class AgentProjectGrants {
  constructor(private readonly store: KeyValueStoreService) {}

  async preview(org: string, user: string, agent: Record<string, unknown>, projectId: string) {
    const owner = await getUserRepository().getLive(org, user);
    if (!owner || owner.isDisabled || owner.isDeleted || owner.kind === 'service' || !await isUserOrgAdmin(user, org)) {
      throw new ForbiddenError('An active organization administrator must approve project schedules.');
    }
    await ProjectsFeature.assertEnabled();
    // Direct and organization-wide project access are supported; team-only access fails closed.
    const { project } = await ProjectService.assertAccess(org, user, projectId, 'viewer');
    ProjectService.assertNotArchived(project);
    const models = await new AiModelsConfigRepository(this.store).read();
    if (!models) throw new ForbiddenError('The model configuration is unavailable.');
    return { project, ...projectGrantPreview(agent, project, models) };
  }

  async approve(org: string, user: string, agentId: string, agent: Record<string, unknown>, projectId: string, fingerprint: string): Promise<AgentProjectGrant> {
    const grantKey = key(org, user, agentId);
    const previous = await this.store.get<string>(grantKey);
    const preview = await this.preview(org, user, agent, projectId);
    if (preview.fingerprint !== fingerprint) throw new ForbiddenError('The agent or project changed. Review the scope again.');
    const grant: AgentProjectGrant = { id: randomUUID(), orgId: org, userId: user, agentId, projectId, fingerprint, approvedAt: Date.now() };
    if (!await this.store.compareAndSet(grantKey, previous, JSON.stringify(grant))) throw new ForbiddenError('Approval changed. Review the scope again.');
    return grant;
  }

  async validate(org: string, user: string, agentId: string, agent: Record<string, unknown>, projectId: string, grantId?: string) {
    const raw = await this.store.get<string>(key(org, user, agentId));
    if (!raw) throw new ForbiddenError('Project schedule approval is missing or revoked.');
    const grant = JSON.parse(raw) as AgentProjectGrant;
    if (grant.orgId !== org || grant.userId !== user || grant.agentId !== agentId || grant.projectId !== projectId || (grantId && grant.id !== grantId)) {
      throw new ForbiddenError('Project schedule approval does not match.');
    }
    const { project, fingerprint, model, modelFingerprint } = await this.preview(org, user, agent, projectId);
    if (fingerprint !== grant.fingerprint) throw new ForbiddenError('The agent or project changed. Review and approve its scope again.');
    return { project, grant, model, modelFingerprint };
  }

  async revoke(org: string, user: string, agentId: string): Promise<void> {
    const grantKey = key(org, user, agentId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.store.get<string>(grantKey);
      if (await this.store.compareAndSet(grantKey, previous, JSON.stringify({ revoked: randomUUID() }))) return;
    }
    throw new ForbiddenError('Approval changed concurrently. Retry revocation.');
  }
}
