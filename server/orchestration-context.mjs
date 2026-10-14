/** Build the exact role-scoped request sent by the orchestration route. */
import { compileSavedHandoffSystemBlock } from './orchestration-contract.mjs';
import { sealedCardSystem } from './orchestration-observation.mjs';

export function compileOrchestrationContext({ snapshot, testInput, messages, board, lane, content, model, sourceObservation }) {
  const slot = snapshot.slots.find(candidate => candidate.id === lane);
  if (!slot) throw new Error(`Unknown orchestration lane: ${lane}`);
  const handoffBlock = compileSavedHandoffSystemBlock({ contract: snapshot.contract, lane, messages, board });
  const baseSystem = handoffBlock ? `${slot.systemPrompt}\n\n${handoffBlock}` : slot.systemPrompt;
  const system = sourceObservation ? sealedCardSystem(baseSystem, sourceObservation.factValue) : baseSystem;
  const shared = board.filter(item => item.targets.includes(lane)).map(item => ({
    role: 'user', content: `Shared finding from ${item.from}: ${item.content}`,
  }));
  const history = messages.filter(message => message.lane === lane).map(({ role, content: messageContent }) => ({ role, content: messageContent }));
  return {
    system,
    messages: [
      { role: 'user', content: `Shared task: ${snapshot.task}\n\nTest case: ${testInput}` },
      ...history,
      ...shared,
      { role: 'user', content },
    ],
    temperature: slot.temperature,
    model,
  };
}
