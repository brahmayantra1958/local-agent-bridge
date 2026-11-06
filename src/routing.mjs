import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENTS } from './protocol.mjs';

export const RUNNERS = Object.freeze(['session', 'native-subagent', 'ccb-worker']);
export const DEFAULT_ROUTING_PROFILE = new URL('../config/routing-profile.v1.json', import.meta.url);
// A profile generated for the apps actually registered in one state root.
export const STATE_ROUTING_PROFILE = 'routing-profile.json';
export const stateRoutingProfilePath = root => join(root, '.bridge', STATE_ROUTING_PROFILE);
// When an app is missing, its roles move to the closest remaining app.
const FALLBACK = Object.freeze({ codex: ['claude', 'gemini'], claude: ['codex', 'gemini'], gemini: ['claude', 'codex'] });
const label = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value);
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const nullable = value => value === null || nonempty(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateRoutingProfile(profile) {
  if (!object(profile) || profile.version !== 1) throw new Error('Unsupported routing profile version');
  if (!label(profile.profileId) || !Number.isSafeInteger(profile.revision) || profile.revision < 1) throw new Error('Invalid routing profile identity');
  if (!['library-default', 'task', 'imported-skill'].includes(profile.scope)) throw new Error('Invalid routing profile scope');
  if (!Array.isArray(profile.sourceSkills) || !Array.isArray(profile.decisionsPending)) throw new Error('Routing profile sources and pending decisions must be arrays');
  for (const source of profile.sourceSkills) {
    if (!object(source) || !nonempty(source.path) || !/^[a-f0-9]{64}$/i.test(source.sha256)) throw new Error('Invalid source skill provenance');
  }
  if (!profile.decisionsPending.every(nonempty) || !Array.isArray(profile.routes) || profile.routes.length === 0) throw new Error('Invalid routing profile routes');
  const ids = new Set(), taskTypes = new Set();
  for (const route of profile.routes) {
    if (!object(route) || !label(route.id) || !label(route.taskType) || ids.has(route.id) || taskTypes.has(route.taskType)) throw new Error('Duplicate or invalid route');
    ids.add(route.id); taskTypes.add(route.taskType);
    if (!AGENTS.includes(route.app) || !nonempty(route.sessionSelector)) throw new Error('Route requires an app and session selector');
    if (!object(route.worker) || !nullable(route.worker.modelId) || !nullable(route.worker.effort)
      || (route.worker.modelId === null) !== (route.worker.effort === null)) throw new Error('Route model and effort must both be specified or both null');
    if (!Array.isArray(route.allowedRunners) || !route.allowedRunners.length
      || new Set(route.allowedRunners).size !== route.allowedRunners.length
      || !route.allowedRunners.every(runner => RUNNERS.includes(runner))) throw new Error('Invalid allowed runners');
    if (!object(route.subagents) || typeof route.subagents.useWhenIndependent !== 'boolean'
      || !(route.subagents.maxConcurrent === null || Number.isSafeInteger(route.subagents.maxConcurrent) && route.subagents.maxConcurrent > 0)) throw new Error('Invalid subagent policy');
    if (route.fallback !== 'no-silent-model-substitution') throw new Error('Unsupported fallback policy');
  }
  return profile;
}

/** Loading policy never mutates a global skill or an application's model selection.
 * Without an explicit path, a state root's generated profile wins over the default. */
export async function loadRoutingProfile(path, { root } = {}) {
  if (path === undefined && root) {
    try { return validateRoutingProfile(JSON.parse(await readFile(stateRoutingProfilePath(root), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return validateRoutingProfile(JSON.parse(await readFile(path ?? DEFAULT_ROUTING_PROFILE, 'utf8')));
}

/** The default profile for all three apps, or a derived one for two apps. Roles of
 * a missing app move to the closest remaining app; a fixed model of the missing
 * app is dropped because another app cannot honor it. */
export function routingProfileForApps(base, apps) {
  validateRoutingProfile(base);
  const present = AGENTS.filter(app => apps.includes(app));
  if (present.length < 2 || apps.some(app => !AGENTS.includes(app))) throw new Error('A routing profile needs at least two known apps');
  if (present.length === AGENTS.length) return base;
  const routes = base.routes.map(route => {
    if (present.includes(route.app)) return route;
    const app = FALLBACK[route.app].find(candidate => present.includes(candidate));
    const runners = route.allowedRunners.filter(runner => runner !== 'ccb-worker');
    return { ...route, app, worker: { ...route.worker, modelId: null, effort: null },
      allowedRunners: runners.length ? runners : ['session'], reassignedFrom: route.app };
  });
  return validateRoutingProfile({ ...base, profileId: base.profileId + '.' + present.join('-'),
    decisionSource: `Generated for the registered apps (${present.join(', ')}); roles of missing apps moved to the closest remaining app.`,
    routes });
}

export function selectRoute(profile, taskType) {
  validateRoutingProfile(profile);
  const route = profile.routes.find(item => item.taskType === taskType);
  if (!route) throw new Error('No configured route for task type: ' + taskType);
  return route;
}

/** Evidence describes a selected session, not a guarantee about a future worker. */
export function selectRunner(route, { runner = 'session', sessionId, evidence } = {}) {
  if (!route.allowedRunners.includes(runner)) throw new Error('Runner is not allowed by this route');
  const exact = route.worker.modelId !== null;
  if (exact && runner !== 'ccb-worker') {
    if (!nonempty(sessionId) || !evidence || evidence.evidenceStatus !== 'observed'
      || evidence.app !== route.app || evidence.sessionId !== sessionId
      || evidence.observedModel !== route.worker.modelId || evidence.observedEffort !== route.worker.effort
      || !object(evidence.source) || !nonempty(evidence.source.path)
      || !Number.isFinite(Date.parse(evidence.observedAt))) {
      throw new Error('Exact model and effort require matching evidence for the selected session');
    }
  }
  return { runner, modelId: route.worker.modelId, effort: route.worker.effort,
    evidenceStatus: exact && runner !== 'ccb-worker' ? 'observed' : 'not-verified' };
}
