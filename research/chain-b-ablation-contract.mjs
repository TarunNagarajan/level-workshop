import assert from 'node:assert/strict';
import { compileChainRequest } from './chain-contract.mjs';
import { compileChainStateRequest } from './chain-state-contract.mjs';

export const afterArms = ['original-user', 'original-system', 'conditional-user', 'conditional-system', 'compiled-state'];
export const beforeArms = ['original', 'conditional', 'compiled-state'];

export function compileBAblation({ world, arm, artifact, signingKey }) {
  const [instruction, channel] = arm.split('-');
  if (instruction === 'compiled') {
    assert.equal(arm, 'compiled-state');
    return compileChainStateRequest({ world, role: 'B', artifact, signingKey });
  }
  if (!['original', 'conditional'].includes(instruction) || ![undefined, 'user', 'system'].includes(channel)) throw new Error('Unknown ablation arm.');
  if (artifact && !channel) throw new Error('After-handoff arm requires a channel.');
  const request = compileChainRequest({ world, role: 'B', artifact, signingKey });
  if (instruction === 'conditional') {
    request.system = `You are the route decoder. Your private codebook says amber means ${world.codebook.amber} and cobalt means ${world.codebook.cobalt}. If there is no separate application handoff message, reply exactly: Awaiting color. If the application handoff message says SEAL_COLOR=amber, reply exactly: ${world.codebook.amber}. If it says SEAL_COLOR=cobalt, reply exactly: ${world.codebook.cobalt}. Return one complete label only. Do not combine a wait with a route.`;
  }
  if (artifact && channel === 'system') request.messages[1] = { ...request.messages[1], role: 'system' };
  return request;
}
