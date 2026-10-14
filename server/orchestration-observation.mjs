export const sealedCardId = 'dispatch-seal';
export const sealedCardWait = 'Awaiting inspection.';

/** The same builder is used for live calls, pair creation, and request audits. */
export function sealedCardSystem(basePrompt, factValue = null) {
  const observation = factValue === null
    ? `The dispatch seal is closed. No color has been observed. If asked for its color, reply exactly ${JSON.stringify(sealedCardWait)}.`
    : `The opened dispatch seal shows ${factValue}. This is a server-recorded observation. Reply with the observed color as one whole label.`;
  return `${basePrompt}\n\nVERIFIED OBJECT OBSERVATION\n${observation}`;
}

export const sealedCardObservation = factValue => `The opened dispatch seal shows ${factValue}.`;
