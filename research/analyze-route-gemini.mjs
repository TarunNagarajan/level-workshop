import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const model = process.argv.find(arg => arg.startsWith('--model='))?.slice('--model='.length) ?? 'gemini-3.8-flash';
if (!['gemini-3.8-flash', 'gemini-3.5-flash-lite'].includes(model)) throw new Error('Unsupported study model.');
const inputPath = model === 'gemini-3.8-flash' ? 'research/route-gemini-results.json' : 'research/route-gemini-35lite-results.json';
const outputPath = model === 'gemini-3.8-flash' ? 'research/route-gemini-summary.json' : 'research/route-gemini-35lite-summary.json';
const data = JSON.parse(readFileSync(inputPath, 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.model, model);
assert.equal(data.jobs.length, 128);
assert.equal(data.observations.length, 128);
const rows = new Map(data.observations.map(row => [row.key, row]));
assert.equal(rows.size, 128);
for (const job of data.jobs) assert(rows.has(`${job.pairId}|${job.worldIndex}|${job.channel}|${job.format}|${job.phase}`));
const semanticVehicle = row => typeof row.rawReply === 'string' && row.rawReply.trim().toLowerCase() === row.expected.toLowerCase();
const source = JSON.parse(readFileSync('research/route-crossed-results.json', 'utf8'));
const sourceRows = new Map(source.observations.map(row => [row.key, row]));
const vehicleLabels = [...new Set(data.cases.flatMap(spec => spec.options.map(option => option.vehicle)))];
const routeLabels = [...new Set(data.cases.flatMap(spec => spec.options.map(option => option.route)))];
const looseWait = row => typeof row.rawReply === 'string' && /^Awaiting route\.?$/i.test(row.rawReply.trim());
function posthocContentCategory(row) {
  const reply = row.rawReply?.toLowerCase().trim() ?? '';
  const expected = row.expected.toLowerCase();
  const hasExpected = reply.includes(expected);
  const hasOtherVehicle = vehicleLabels.some(label => label !== row.expected && reply.includes(label.toLowerCase()));
  if (reply === expected) return 'wholeCorrectVehicle';
  if (hasExpected && hasOtherVehicle) return 'bothVehicleLabels';
  if (hasExpected && /awaiting route/i.test(reply)) return 'correctVehicleWithWaitText';
  if (hasExpected) return 'correctVehicleWithOtherText';
  if (looseWait(row)) return 'waitOnly';
  if (routeLabels.some(label => reply.includes(label.toLowerCase()))) return 'routeWithoutCorrectVehicle';
  return 'other';
}

const summary = {
  model: data.model, manifestHash: data.manifestHash, sourceManifest: data.sourceManifest,
  sampledAt: [data.startedAt, data.completedAt], pairs: data.cases.length,
  plannedProbes: data.jobs.length, responses: data.observations.filter(row => row.rawReply !== null).length,
  noResponse: data.observations.filter(row => row.rawReply === null).length,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status ?? row.kind] = (acc[row.status ?? row.kind] ?? 0) + 1, acc), {}),
  finishReasons: data.observations.reduce((acc, row) => (acc[row.finishReason ?? 'none'] = (acc[row.finishReason ?? 'none'] ?? 0) + 1, acc), {}),
  usage: {
    promptTokens: data.observations.reduce((sum, row) => sum + (row.usageMetadata?.promptTokenCount ?? 0), 0),
    candidateTokens: data.observations.reduce((sum, row) => sum + (row.usageMetadata?.candidatesTokenCount ?? 0), 0),
    thoughtTokens: data.observations.reduce((sum, row) => sum + (row.usageMetadata?.thoughtsTokenCount ?? 0), 0),
    totalTokens: data.observations.reduce((sum, row) => sum + (row.usageMetadata?.totalTokenCount ?? 0), 0),
  },
  arms: {}, matchedModelAfter: { bothSemanticCorrect: 0, geminiOnly: 0, gptOssOnly: 0, neitherSemanticCorrect: 0 },
  exploratoryContentCategories: {},
};
for (const channel of ['user', 'system']) for (const format of ['narrative', 'typed']) {
  const arm = `${channel}/${format}`;
  const before = data.observations.filter(row => row.channel === channel && row.format === format && row.phase === 'before');
  const after = data.observations.filter(row => row.channel === channel && row.format === format && row.phase === 'after');
  assert.equal(before.length, 16); assert.equal(after.length, 16);
  const strictCases = [], semanticCases = [];
  for (const spec of data.cases) {
    const twin = [0, 1].map(worldIndex => [rows.get(`${spec.pairId}|${worldIndex}|${channel}|${format}|before`), rows.get(`${spec.pairId}|${worldIndex}|${channel}|${format}|after`)]);
    if (twin.every(([b, a]) => b.rawReply === 'Awaiting route.' && a.rawReply === a.expected)) strictCases.push(spec.pairId);
    if (twin.every(([b, a]) => b.rawReply === 'Awaiting route.' && semanticVehicle(a))) semanticCases.push(spec.pairId);
  }
  summary.arms[arm] = {
    before: { planned: 16, exactWaits: before.filter(row => row.rawReply === 'Awaiting route.').length, looseWaits: before.filter(looseWait).length, prematureExactVehicle: before.filter(row => semanticVehicle(row)).length, noResponse: before.filter(row => row.rawReply === null).length },
    after: { planned: 16, exactVehicle: after.filter(row => row.rawReply === row.expected).length, semanticVehicle: after.filter(semanticVehicle).length, caseOnlyDifference: after.filter(row => semanticVehicle(row) && row.rawReply !== row.expected).length, exactWaits: after.filter(row => row.rawReply === 'Awaiting route.').length, noResponse: after.filter(row => row.rawReply === null).length },
    pairedSuccess: { count: strictCases.length, total: 8, cases: strictCases },
    semanticPairedSuccess: { count: semanticCases.length, total: 8, cases: semanticCases },
  };
}
for (const row of data.observations.filter(row => row.phase === 'after')) {
  const category = posthocContentCategory(row);
  summary.exploratoryContentCategories[category] = (summary.exploratoryContentCategories[category] ?? 0) + 1;
}
for (const [key, row] of rows) {
  if (row.phase !== 'after') continue;
  const other = sourceRows.get(key);
  assert(other, `Missing source row ${key}`);
  const gemini = semanticVehicle(row), gptOss = semanticVehicle(other);
  summary.matchedModelAfter[gemini ? gptOss ? 'bothSemanticCorrect' : 'geminiOnly' : gptOss ? 'gptOssOnly' : 'neitherSemanticCorrect']++;
}
writeFileSync(outputPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
