import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueArtifact } from './handoff-contract.mjs';
import { auditRoutePair, compileRouteRequest, evaluateRouteReply, routeWorlds, scoreRouteReply } from './route-contract.mjs';

test('route handoff is necessary at the request boundary in both worlds', () => {
  const worlds = routeWorlds();
  assert.equal(auditRoutePair(worlds).indistinguishableBeforeHandoff, true);
  const signingKey = 'route-test-key';
  for (const world of worlds) {
    const route = issueArtifact({ world, kind: 'route', sourceRole: 'A', sourceEventId: 'route-finding', payload: { route: world.openRoute }, signingKey });
    const b = compileRouteRequest({ world, role: 'B', artifact: route, signingKey });
    assert.match(b.messages[1].content, new RegExp(world.openRoute));
    const bSystem = compileRouteRequest({ world, role: 'B', artifact: route, signingKey, handoffChannel: 'system' });
    assert.equal(bSystem.system, `${b.system}\n${b.messages[1].content}`);
    assert.deepEqual(bSystem.messages, [b.messages[0], b.messages[2]]);
    const plan = issueArtifact({ world, kind: 'plan', sourceRole: 'B', sourceEventId: 'vehicle-choice', payload: { route: world.openRoute, vehicle: world.vehicle }, signingKey });
    const c = compileRouteRequest({ world, role: 'C', artifact: plan, signingKey });
    assert.match(c.messages[1].content, new RegExp(world.vehicle));
    const systemHandoff = compileRouteRequest({ world, role: 'C', artifact: plan, signingKey, handoffChannel: 'system' });
    assert.match(systemHandoff.system, new RegExp(world.vehicle));
    assert.equal(systemHandoff.messages.length, 2);
    const stateHandoff = compileRouteRequest({ world, role: 'C', artifact: plan, signingKey, handoffChannel: 'state' });
    assert.match(stateHandoff.system, new RegExp(`PLAN=${world.vehicle}`));
    assert.equal(stateHandoff.messages.length, 2);
    assert.throws(() => compileRouteRequest({ world, role: 'C', artifact: route, signingKey }), /cannot receive/);
  }
});

test('route publication distinguishes absent handoff, wrong source fact, and output override', () => {
  const [world] = routeWorlds();
  const signingKey = 'route-test-key';
  const valid = issueArtifact({ world, kind: 'route', sourceRole: 'A', sourceEventId: 'route-finding', payload: { route: world.openRoute }, signingKey });
  const wrong = issueArtifact({ world, kind: 'route', sourceRole: 'A', sourceEventId: 'route-finding-wrong', payload: { route: 'Canal Ferry' }, signingKey });
  assert.equal(evaluateRouteReply({ world, rawReply: 'pickup truck', signingKey }).gate, 'missing-prerequisite');
  assert.equal(evaluateRouteReply({ world, artifact: valid, rawReply: 'cargo van', signingKey }).gate, 'output-mismatch');
  assert.equal(evaluateRouteReply({ world, artifact: wrong, rawReply: 'cargo van', signingKey }).gate, 'source-factual-error');
  assert.equal(evaluateRouteReply({ world, artifact: valid, rawReply: 'pickup truck', signingKey }).gate, 'open');
});

test('route scorer separates vehicle choice from strict response format', () => {
  const [world] = routeWorlds();
  assert.deepEqual(scoreRouteReply({ world, rawReply: 'Pickup Truck' }), { chosenVehicle: 'pickup truck', semanticCorrect: true, exactFormat: false });
  assert.deepEqual(scoreRouteReply({ world, rawReply: 'pickup truck' }), { chosenVehicle: 'pickup truck', semanticCorrect: true, exactFormat: true });
  assert.deepEqual(scoreRouteReply({ world, rawReply: 'cargo van' }), { chosenVehicle: 'cargo van', semanticCorrect: false, exactFormat: false });
  assert.deepEqual(scoreRouteReply({ world, rawReply: 'pickup truck.' }), { chosenVehicle: null, semanticCorrect: false, exactFormat: false });
  assert.throws(() => routeWorlds({ options: [{ route: 'North', vehicle: 'Van' }, { route: 'South', vehicle: 'van' }] }), /distinct/);
});
