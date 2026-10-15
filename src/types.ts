export type User = { id: string; name: string; email: string; role: 'admin' | 'editor' };
export type Level = {
  title: string; theme: string; character: string; briefing: string; secret: string; criteria: string;
  systemPrompt: string; opening: string; clues: string; hints: string[];
  mode: 'deduction' | 'jailbreak'; duration: number; responseWords: number; temperature: number;
};
export type Version = { id: string; number: number; data: Level; note: string; author: string; createdAt: number };
export type Summary = { id: string; draft: Level; revision: number; status: string; owner: string; ownerId: string; updatedAt: number; versions: number; attempts: number };
export type Detail = Omit<Summary, 'versions'> & { versions: Version[]; comments: { id: string; text: string; author: string; created_at: number }[]; links: { id: string; versionId: string; createdAt: number; expires: number; revoked: number }[] };
export type PlayerLevel = Pick<Level, 'title' | 'theme' | 'character' | 'briefing' | 'opening' | 'duration'> & { hintCount: number };
export type Message = { id: string; role: 'user' | 'assistant' | 'hint'; content: string; createdAt: number; opening?: boolean; latencyMs?: number; usage?: number; model?: string; deskContext?: string; presented?: string[] };
export type Review = { outcome: string; note: string; evidence: string; reviewer?: string };
export type MachineReview = { status: 'pending' | 'unavailable' | 'complete'; attempts: number; retryable: boolean; errorCode?: string; verdict?: 'recovered' | 'partial' | 'not_recovered' | 'uncertain'; reason?: string; evidence?: { replyId: string; quote: string }[]; completedAt?: number };
export type Round = { id: string; versionId?: string; inspectionMode?: 'documents'; version?: number; level: PlayerLevel; model?: string; tester: string; messages: Message[]; startedAt: number; deadline: number; endedAt: number | null; answer: string | null; hintsUsed: number; source?: string; accessToken?: string; review?: Review | null; reviewEnabled?: boolean; machineReview?: MachineReview };
export type Attempt = Round & { data: Level; config: { model: string; baseUrl: string }; parentId?: string | null; desk?: { evidence: string[]; events: { id: string; action: string; observation: string }[]; decision: string | null } };
export type Bootstrap = { needsSetup: boolean; privateEntry?: boolean; rootEntry: boolean; tutorialDone?: boolean; recordingNoticeRequired?: boolean; recordingAccepted?: boolean; recordingNoticeVersion?: string; user: User | null; model: { connected: boolean; model?: string; provider?: string } };
