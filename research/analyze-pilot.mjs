import { readFileSync, writeFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('research/paired-world-pilot.json', 'utf8'));
const observations = data.observations;
const pre = visibility => observations.filter(row => row.phase === 'before handoff' && row.visibility === visibility);
const post = observations.filter(row => row.phase !== 'before handoff');
const containsAnswer = row => new RegExp(`\\b${row.expectedAnswer}\\b`).test(row.response ?? '');
const summary = {
  model: data.model,
  worlds: data.worlds.length,
  plannedProbes: observations.length,
  responses: observations.filter(row => row.response !== null).length,
  noResponse: observations.filter(row => row.response === null).length,
  providerErrorsAcrossAttempts: data.providerErrors?.length ?? 0,
  fullCase: {
    probes: pre('full-case').length,
    earlyFinalAnswers: pre('full-case').filter(containsAnswer).length,
    noResponse: pre('full-case').filter(row => row.response === null).length,
  },
  gated: {
    probes: pre('gated').length,
    exactWaits: pre('gated').filter(row => row.response === 'Awaiting handoff.').length,
    noResponse: pre('gated').filter(row => row.response === null).length,
  },
  postHandoff: {
    probes: post.length,
    responsesContainingWorldAnswer: post.filter(containsAnswer).length,
    presenterResponsesContainingWorldAnswer: post.filter(row => row.role === 'C' && containsAnswer(row)).length,
    presenterResponsesWithStaleWaitText: post.filter(row => row.role === 'C' && /awaiting handoff/i.test(row.response ?? '')).length,
  },
};
writeFileSync('research/paired-world-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
