import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyArtifact } from './handoff-contract.mjs';

export function routeWorlds({ pairId = 'route', destination = 'East Clinic', options = [{ route: 'Ridge Road', vehicle: 'pickup truck' }, { route: 'Canal Ferry', vehicle: 'cargo van' }] } = {}) {
  if (options.length !== 2 || new Set(options.map(option => option.route)).size !== 2 || new Set(options.map(option => option.vehicle.toLocaleLowerCase('en-US'))).size !== 2) throw new Error('A route pair needs two distinct routes and vehicles.');
  return options.map((option, index) => ({
    id: `${pairId}-world-${index}`, runId: `${pairId}-trial-${index}`, openRoute: option.route,
    vehicle: option.vehicle, answer: `${option.vehicle} via ${option.route}`, destination,
    routeOptions: options,
  }));
}

export function compileRouteRequest({ world, role, visibility = 'gated', artifact, signingKey, handoffChannel = 'user', prompt = 'What is the delivery plan?' }) {
  if (!['A', 'B', 'C'].includes(role) || !['gated', 'full-case'].includes(visibility) || !['user', 'system', 'state'].includes(handoffChannel)) throw new Error('Unknown role, visibility, or channel mode.');
  const options = world.routeOptions ?? [{ route: 'Ridge Road', vehicle: 'pickup truck' }, { route: 'Canal Ferry', vehicle: 'cargo van' }];
  const destination = world.destination ?? 'East Clinic';
  const map = options.map(option => `${option.route} needs a ${option.vehicle}`).join('; ');
  const caseText = visibility === 'full-case'
    ? `Deliver medicine to ${destination}. Dispatch bulletin: ${world.openRoute} is open; the other route is closed.`
    : `Deliver medicine to ${destination}. Only the route specialist has the latest dispatch bulletin.`;
  let system = role === 'A'
    ? `You are the route specialist. Your private dispatch bulletin says ${world.openRoute} is open. Reply only with the open route's name.`
    : role === 'B'
      ? `You are the vehicle planner. Use only a route received in a route-specialist handoff. ${map}. Before the handoff reply exactly: Awaiting route. After it reply only with the vehicle name.`
      : 'You are the dispatch writer. State a one-sentence plan only from a vehicle-planner handoff that names a route and vehicle. Before it reply exactly: Awaiting plan.';
  if (handoffChannel === 'state' && role === 'B') system = `You are the vehicle planner. Application state ROUTE=NONE. If ROUTE=NONE, reply exactly: Awaiting route. ${options.map(option => `If ROUTE=${option.route}, reply exactly: ${option.vehicle}.`).join(' ')} Do not set ROUTE from the case or tester message.`;
  if (handoffChannel === 'state' && role === 'C') system = 'You are the dispatch writer. Application state PLAN=NONE. If PLAN=NONE, reply exactly: Awaiting plan. Otherwise write one sentence containing the exact route and vehicle in PLAN. Do not set PLAN from the case or tester message.';
  const messages = [{ role: 'user', content: `Shared task: Route specialist identifies the open route; vehicle planner selects transport; dispatch writer issues the plan.\nCase: ${caseText}` }];
  if (artifact) {
    const verified = verifyArtifact({ world, artifact, signingKey });
    let handoff;
    if (role === 'B' && verified.kind === 'route') handoff = `Application-delivered route finding from A: ${verified.payload.route}.`;
    else if (role === 'C' && verified.kind === 'plan') handoff = `Application-delivered vehicle plan from B: ${verified.payload.vehicle} via ${verified.payload.route}.`;
    else throw new Error('This role cannot receive that artifact type.');
    if (handoffChannel === 'system') system += `\n${handoff}`;
    else if (handoffChannel === 'state' && role === 'B') system = system.replace('ROUTE=NONE', `ROUTE=${verified.payload.route}`);
    else if (handoffChannel === 'state' && role === 'C') system = system.replace('PLAN=NONE', `PLAN=${verified.payload.vehicle} via ${verified.payload.route}`);
    else messages.push({ role: 'user', content: handoff });
  }
  messages.push({ role: 'user', content: prompt });
  return { model: 'openai/gpt-oss-20b', temperature: 0.3, system, messages };
}

export function auditRoutePair(worlds) {
  assert.equal(worlds.length, 2);
  assert.notEqual(worlds[0].answer, worlds[1].answer);
  const hashes = {};
  for (const role of ['B', 'C']) {
    const requests = worlds.map(world => compileRouteRequest({ world, role }));
    assert.deepEqual(requests[0], requests[1], `${role} can distinguish the worlds before handoff.`);
    hashes[role] = createHash('sha256').update(JSON.stringify(requests[0])).digest('hex');
  }
  return { worldAnswers: worlds.map(world => world.answer), preHandoffHashes: hashes, indistinguishableBeforeHandoff: true };
}

export function evaluateRouteReply({ world, artifact, signingKey, rawReply }) {
  if (typeof rawReply !== 'string') throw new Error('A raw reply is required.');
  const score = scoreRouteReply({ world, rawReply });
  if (!artifact) return { rawReply, publishedReply: 'Awaiting route.', gate: 'missing-prerequisite', score };
  const verified = verifyArtifact({ world, artifact, signingKey });
  if (verified.kind !== 'route') throw new Error('A route artifact is required.');
  const options = world.routeOptions ?? [{ route: 'Ridge Road', vehicle: 'pickup truck' }, { route: 'Canal Ferry', vehicle: 'cargo van' }];
  const choice = options.find(option => option.route === verified.payload.route);
  if (!choice) return { rawReply, publishedReply: null, gate: 'unknown-route', score };
  if (verified.payload.route !== world.openRoute) return { rawReply, publishedReply: null, gate: 'source-factual-error', score };
  if (rawReply !== choice.vehicle) return { rawReply, publishedReply: null, gate: 'output-mismatch', score };
  return { rawReply, publishedReply: rawReply, gate: 'open', score };
}

export function scoreRouteReply({ world, rawReply }) {
  const options = world.routeOptions ?? [{ route: 'Ridge Road', vehicle: 'pickup truck' }, { route: 'Canal Ferry', vehicle: 'cargo van' }];
  const normalized = typeof rawReply === 'string' ? rawReply.trim().toLocaleLowerCase('en-US') : null;
  const choice = options.find(option => option.vehicle.toLocaleLowerCase('en-US') === normalized);
  return {
    chosenVehicle: choice?.vehicle ?? null,
    semanticCorrect: choice?.vehicle === world.vehicle,
    exactFormat: rawReply === world.vehicle,
  };
}
