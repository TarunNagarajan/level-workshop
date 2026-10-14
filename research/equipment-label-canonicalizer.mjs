import { equipmentDecision, verifiedEquipmentState } from './equipment-model-contract.mjs';

const labels = new Map([
  ['awaiting inspection', 'Awaiting inspection.'],
  ['hold', 'hold'],
  ['release', 'release'],
]);

export function canonicalEquipmentLabel(raw) {
  if (typeof raw !== 'string') return null;
  const input = raw.trim();
  if (!/^(?:Awaiting inspection|hold|release)\.?$/i.test(input)) return null;
  return labels.get(input.toLowerCase().replace(/\.$/, '')) ?? null;
}

export function canonicalEquipmentPublication(raw, payload) {
  const actual = canonicalEquipmentLabel(raw);
  const expected = equipmentDecision(verifiedEquipmentState(payload));
  return { actual, expected, status: actual === null || actual !== expected ? 'rejected'
    : actual === 'Awaiting inspection.' ? 'waiting' : 'published' };
}
