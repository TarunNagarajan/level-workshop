import { readFileSync, writeFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('research/route-gemini-results.json', 'utf8'));
const summary = {
  model: data.model,
  status: data.status,
  manifestHash: data.manifestHash,
  plannedProbes: data.jobs.length,
  attemptedProbes: data.observations.length,
  replies: data.observations.filter(row => row.rawReply !== null).length,
  noResponse: data.observations.filter(row => row.rawReply === null).length,
  providerAttemptErrors: data.providerErrors.length,
  errorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status ?? row.kind] = (acc[row.status ?? row.kind] ?? 0) + 1, acc), {}),
  interpretation: 'Availability diagnostic only. The incomplete, provider-selected subset is not a model-quality comparison.',
};
writeFileSync('research/route-gemini-availability-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
