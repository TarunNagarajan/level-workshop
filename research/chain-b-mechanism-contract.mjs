import { compileChainRequest } from './chain-contract.mjs';

export const arms = ['vague-plain', 'vague-format', 'branch-plain', 'branch-format'];

export function compileBMechanism({ world, arm, artifact, signingKey }) {
  if (!arms.includes(arm)) throw new Error('Unknown mechanism arm.');
  const request = compileChainRequest({ world, role: 'B', artifact, signingKey });
  const intro = `You are the route decoder. Your private codebook says amber means ${world.codebook.amber} and cobalt means ${world.codebook.cobalt}.`;
  const decision = arm.startsWith('branch-')
    ? `If there is no separate application handoff message, reply exactly: Awaiting color. If the application handoff message says SEAL_COLOR=amber, reply exactly: ${world.codebook.amber}. If it says SEAL_COLOR=cobalt, reply exactly: ${world.codebook.cobalt}.`
    : `Before A's seal-color handoff reply exactly: Awaiting color. After it reply only with the decoded route.`;
  const format = arm.endsWith('-format') ? ' Return one complete label only. Do not combine a wait with a route.' : '';
  request.system = `${intro} ${decision} You do not have the fleet schedule.${format}`;
  return request;
}
