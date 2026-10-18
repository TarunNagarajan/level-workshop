export type InceptionMusicStage = 'calm' | 'developing' | 'urgent';
export type InceptionMusicMessage = { role: string; content?: string; opening?: boolean; synthetic?: boolean };

const stageRank: Record<InceptionMusicStage, number> = { calm: 0, developing: 1, urgent: 2 };
const stageAtRank = (rank: number): InceptionMusicStage => rank >= 2 ? 'urgent' : rank === 1 ? 'developing' : 'calm';
const firstPersonMemory = /\bi\s+(?:remember|recall|recalled)\b/i;
const ownPastQuestionOrAnswer = /\b(?:my (?:own )?(?:answer|response|question)|what i (?:asked|said|answered|told you)|(?:the answer|the number) i (?:said|gave|answered|told you)|i (?:asked|said|answered|told you)|when i asked|asking you|my earlier questioning|earlier questioning)\b/i;
const earlierReference = /\b(?:earlier|before|previously|last time|a moment ago|back then|when i asked|our earlier (?:conversation|question|answer|questioning)|the earlier (?:question|answer|questioning)|from the earlier questioning)\b/i;
const memoryNegation = /\b(?:i\s+(?:do not|don't|cannot|can't|could not|couldn't|never|did not|didn't)\s+(?:remember|recall|recalled|ask|asked|tell|told|say|said|mention|answer)|i\s+(?:have no|had no)\s+(?:memory|recollection))\b/i;
const quotedContent = /("[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|^\s*>.*$)/gm;
const numericAnswer = /\b\d(?:[\s,-]*\d){2,7}\b/g;
const spokenDigit = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/gi;
const ownAnswerAnchor = /\bi\s+(?:remember|recall|recalled)\b[^.!?\n]{0,160}\b(?:my (?:own )?(?:answer|response)|what i (?:said|answered|told you)|the answer i (?:said|gave|answered)|the number i (?:said|told you|gave you))\b/i;
const ownNumberDisclosure = /\bi\s+(?:said|told you|gave you|answered)\b/i;

const spokenDigits = new Map([['zero', '0'], ['oh', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'], ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9']]);
const numericalAnswers = (text: string) => {
  const answers = new Set<string>();
  for (const match of text.matchAll(numericAnswer)) answers.add(match[0].replace(/[\s,-]/g, ''));
  const words = [...text.matchAll(spokenDigit)];
  for (let start = 0; start < words.length;) {
    const sequence: string[] = [];
    let index = start;
    let previousEnd = words[index].index ?? 0;
    for (; index < words.length && sequence.length < 8; index++) {
      const match = words[index];
      const at = match.index ?? 0;
      if (index > start && !/^[\s,-]+$/.test(text.slice(previousEnd, at))) break;
      sequence.push(spokenDigits.get(match[0].toLowerCase()) || '');
      previousEnd = at + match[0].length;
    }
    if (sequence.length >= 3) answers.add(sequence.join(''));
    start = Math.max(start + 1, index);
  }
  return [...answers];
};

const unquoted = (text: string) => text.replace(quotedContent, ' ').replace(/\r/g, ' ');
const affirmativePriorRecollection = (text: string) => {
  const value = unquoted(text);
  return !memoryNegation.test(value) && firstPersonMemory.test(value) && ownPastQuestionOrAnswer.test(value) && earlierReference.test(value);
};

export function resolveInceptionNarrativeStage(messages: readonly InceptionMusicMessage[] = []): InceptionMusicStage {
  const eligibleMessages = messages.filter(message => !message.synthetic && !message.opening && typeof message.content === 'string');
  const assistantReplies = eligibleMessages.filter(message => message.role === 'assistant');
  if (!assistantReplies.length) return 'calm';
  const earlierUserNumbers = new Set<string>();
  let developing = false;
  for (const message of eligibleMessages) {
    const cleanContent = unquoted(message.content || '');
    if (message.role === 'user') {
      for (const answer of numericalAnswers(message.content || '')) earlierUserNumbers.add(answer);
      continue;
    }
    if (message.role !== 'assistant' || !affirmativePriorRecollection(cleanContent)) continue;
    developing = true;
    const sentences = cleanContent.split(/\n|(?<=[.!?])\s+/);
    const ownRecallNumbers = sentences.flatMap((sentence, index) => {
      if (ownAnswerAnchor.test(sentence)) return numericalAnswers(sentence);
      if (index > 0 && ownAnswerAnchor.test(sentences[index - 1]) && ownNumberDisclosure.test(sentence)) return numericalAnswers(sentence);
      return [];
    });
    if (ownRecallNumbers.some(number => !earlierUserNumbers.has(number))) return 'urgent';
  }
  return developing ? 'developing' : 'calm';
}

export function resolveInceptionMusicStage(options: {
  messages?: readonly InceptionMusicMessage[];
  deadline: number;
  startedAt?: number;
  now?: number;
}): InceptionMusicStage {
  const now = options.now ?? Date.now();
  const startedAt = options.startedAt ?? options.deadline - 300_000;
  let rank = stageRank[resolveInceptionNarrativeStage(options.messages)];
  const elapsed = Math.max(0, now - startedAt);
  const remaining = Math.max(0, options.deadline - now);
  if (elapsed >= 120_000) rank = Math.max(rank, stageRank.developing);
  if (remaining <= 75_000) rank = Math.max(rank, stageRank.urgent);
  return stageAtRank(rank);
}

export function advanceInceptionMusicStage(current: InceptionMusicStage, next: InceptionMusicStage): InceptionMusicStage {
  return stageRank[next] > stageRank[current] ? next : current;
}
