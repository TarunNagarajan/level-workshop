import assert from 'node:assert/strict';

export const observationChannels = [
  'domText', 'accessibility', 'renderedPixels', 'actionPayload', 'resourceRequests', 'downloadedBytes', 'decodedAssetPixels', 'assetMetadata',
];

function byResource(network) {
  const grouped = new Map();
  for (const row of network) grouped.set(row.path, [...(grouped.get(row.path) || []),
    { status: row.status, contentType: row.contentType, hash: row.hash }]);
  return grouped;
}

export function compareObserverBoundary(left, right) {
  const a = byResource(left.network), b = byResource(right.network);
  const resourcePaths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const requestShape = rows => rows?.map(({ status, contentType }) => ({ status, contentType })) ?? null;
  const differingRequests = resourcePaths.filter(path => JSON.stringify(requestShape(a.get(path))) !== JSON.stringify(requestShape(b.get(path))));
  const differingResources = resourcePaths.filter(path => JSON.stringify(a.get(path)) !== JSON.stringify(b.get(path)));
  return {
    channels: {
      domText: left.textHash === right.textHash,
      accessibility: left.accessibilityHash === right.accessibilityHash,
      renderedPixels: left.screenshotPixelHash === right.screenshotPixelHash,
      actionPayload: (left.actionPayloadHash ?? null) === (right.actionPayloadHash ?? null),
      resourceRequests: differingRequests.length === 0,
      downloadedBytes: differingResources.length === 0,
      decodedAssetPixels: left.coverPixelHash === right.coverPixelHash,
      assetMetadata: left.exifHash === right.exifHash,
    },
    differingRequests,
    differingResources,
  };
}

export function certifyObserverCut(left, right, declaredChannels) {
  assert.ok(Array.isArray(declaredChannels) && declaredChannels.length, 'Declare at least one player observation channel.');
  for (const channel of declaredChannels) assert.ok(observationChannels.includes(channel), `Unknown observation channel: ${channel}`);
  const comparison = compareObserverBoundary(left, right);
  return { ...comparison, declaredChannels, status: declaredChannels.every(channel => comparison.channels[channel]) ? 'equivalent' : 'exposed' };
}
