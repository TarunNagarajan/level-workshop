import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const hash = value => createHash('sha256').update(value).digest('hex');

function changedJsonPaths(left, right, prefix = '$') {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object'
    || Array.isArray(left) !== Array.isArray(right)) return [prefix];
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap(key => changedJsonPaths(left[key], right[key], Array.isArray(left)
    ? `${prefix}[${key}]` : `${prefix}.${key}`));
}

function pixelDifference(left, right) {
  if (left.info.width !== right.info.width || left.info.height !== right.info.height)
    return { dimensionsDiffer: true, leftSize: [left.info.width, left.info.height],
      rightSize: [right.info.width, right.info.height] };
  const { width, height, channels } = left.info;
  assert.equal(channels, 4);
  assert.equal(right.info.channels, 4);
  let changedPixels = 0, leftX = width, top = height, rightX = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    if (left.data[offset] === right.data[offset] && left.data[offset + 1] === right.data[offset + 1]
      && left.data[offset + 2] === right.data[offset + 2] && left.data[offset + 3] === right.data[offset + 3]) continue;
    changedPixels++;
    leftX = Math.min(leftX, x); top = Math.min(top, y);
    rightX = Math.max(rightX, x); bottom = Math.max(bottom, y);
  }
  return { dimensionsDiffer: false, width, height, changedPixels,
    bounds: changedPixels ? { x: leftX, y: top, width: rightX - leftX + 1, height: bottom - top + 1 } : null };
}

/** Add concrete first-difference locations and verify capture hashes against actual PNG pixels. */
export async function localizeAuthorAuditBundle(bundle, scenarios) {
  const source = new Map(scenarios.map(scenario => [scenario.id, scenario]));
  const decoded = new Map();
  async function image(path, expectedFileHash, expectedPixelHash) {
    if (!decoded.has(path)) {
      const bytes = readFileSync(`research/${path}`);
      assert.equal(hash(bytes), expectedFileHash, `${path}: PNG bytes changed`);
      const value = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      decoded.set(path, value);
    }
    const value = decoded.get(path);
    assert.equal(hash(value.data), expectedPixelHash, `${path}: capture pixel hash differs from PNG`);
    return value;
  }
  for (const scenario of bundle.scenarios) {
    const original = source.get(scenario.id);
    assert.ok(original, `Missing source scenario ${scenario.id}`);
    for (const [index, stage] of scenario.stages.entries()) {
      const captures = original.rows.map(row => row.trace[index].capture);
      const pictures = await Promise.all(stage.screenshots.map((shot, world) => image(
        shot.path, shot.hash, captures[world].screenshotPixelHash)));
      for (const capture of captures) assert.equal(capture.actionPayloadHash ?? null,
        capture.actionPayload === null ? null : hash(JSON.stringify(capture.actionPayload)),
        `${scenario.id}/${stage.action}: response hash differs from captured payload`);
      const pixels = pixelDifference(...pictures);
      assert.equal(Boolean(pixels.dimensionsDiffer || pixels.changedPixels), !stage.equalByChannel.renderedPixels,
        `${scenario.id}/${stage.action}: screen channel disagrees with PNG pixels`);
      const changedFields = changedJsonPaths(...captures.map(capture => capture.actionPayload));
      assert.equal(changedFields.length > 0, !stage.equalByChannel.actionPayload,
        `${scenario.id}/${stage.action}: response channel disagrees with captured payload`);
      stage.localization = { pixels, actionFields: changedFields,
        resources: stage.differingResources, requests: stage.differingRequests };
    }
  }
  return bundle;
}
