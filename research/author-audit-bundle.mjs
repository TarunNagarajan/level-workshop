import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compareObserverBoundary } from './observer-relative-cut.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const authorAuditChannels = ['domText', 'accessibility', 'renderedPixels', 'actionPayload', 'downloadedBytes'];

/** Compile saved paired browser traces into a portable, author-facing witness bundle. */
export function compileAuthorAuditBundle({ sceneId, title, scenarios, sourceReports }) {
  assert.match(sceneId, /^[a-z][a-z0-9-]*$/);
  assert.ok(typeof title === 'string' && title.trim());
  assert.ok(Array.isArray(scenarios) && scenarios.length);
  assert.ok(Array.isArray(sourceReports) && sourceReports.length);
  const reportHashes = Object.fromEntries(sourceReports.map(path => [path, hash(readFileSync(path))]));
  const ids = new Set();
  const compiled = scenarios.map(scenario => {
    const { id, label, factLabel, declaredEvent, worldLabels, answers, rows, screenshotRoot } = scenario;
    assert.match(id, /^[a-z][a-z0-9-]*$/);
    assert.ok(!ids.has(id), `Duplicate scenario ${id}`); ids.add(id);
    assert.ok([label, factLabel, declaredEvent].every(value => typeof value === 'string' && value.trim()));
    assert.ok(Array.isArray(worldLabels) && worldLabels.length === 2);
    assert.ok(Array.isArray(answers) && answers.length === 2 && answers[0] !== answers[1], `${id}: outcomes must differ`);
    assert.ok(Array.isArray(rows) && rows.length === 2 && rows.every(row => Array.isArray(row.trace) && row.trace.length));
    assert.ok(typeof screenshotRoot === 'string' && /^browser-[a-z0-9-]+$/.test(screenshotRoot));
    assert.deepEqual(rows[0].trace.map(stage => stage.action), rows[1].trace.map(stage => stage.action), `${id}: paired actions differ`);
    const actionPath = rows[0].trace.map(stage => stage.action);
    assert.equal(new Set(actionPath).size, actionPath.length, `${id}: repeated action stage is ambiguous`);
    const eventIndex = actionPath.indexOf(declaredEvent) < 0 ? Infinity : actionPath.indexOf(declaredEvent);
    const stages = actionPath.map((action, index) => {
      const screenshots = rows.map(row => {
        const filename = `${screenshotRoot}/${row.name}-${action}.png`;
        assert.ok(!filename.includes('..') && !filename.includes('\\'));
        assert.equal(hash(readFileSync(`research/${filename}`)), row.trace[index].screenshotHash,
          `${id}: screenshot hash does not match ${filename}`);
        return { path: filename, hash: row.trace[index].screenshotHash };
      });
      const comparison = compareObserverBoundary(rows[0].trace[index].capture, rows[1].trace[index].capture);
      return { action, screenshots, equalByChannel: Object.fromEntries(authorAuditChannels.map(channel => [channel, comparison.channels[channel]])),
        differingResources: comparison.differingResources, differingRequests: comparison.differingRequests };
    });
    const firstDifference = Object.fromEntries(authorAuditChannels.map(channel => {
      const index = stages.findIndex(stage => !stage.equalByChannel[channel]);
      return [channel, { stageIndex: index < 0 ? null : index, action: index < 0 ? null : stages[index].action,
        status: index < 0 ? 'unrevealed' : index < eventIndex ? 'exposed-before-event'
          : index === eventIndex ? 'revealed-at-event' : 'revealed-after-event' }];
    }));
    return { id, label, factLabel, declaredEvent, worldLabels, answers, actionPath, stages, firstDifference,
      eventReached: Number.isFinite(eventIndex), sourceScenario: scenario.sourceScenario ?? null };
  });
  return { schemaVersion: 1, sceneId, title, channels: authorAuditChannels,
    reportHashes, scenarios: compiled,
    scope: 'Finite saved paired browser traces and the declared observer channels. A bundle is a witness collection, not an all-history or model-behavior certificate.' };
}
