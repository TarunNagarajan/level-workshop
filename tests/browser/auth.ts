import type { APIRequestContext } from '@playwright/test';

const owner = { name: 'Workshop owner', email: 'ui-owner@example.test', password: 'ui-verification-password' };

export async function signInOwner(request: APIRequestContext) {
  const bootstrap = await (await request.get('/api/bootstrap')).json();
  const response = bootstrap.needsSetup
    ? await request.post('/api/setup', { data: owner })
    : await request.post('/api/login', { data: { email: owner.email, password: owner.password } });
  if (!response.ok()) throw new Error(`Test owner sign-in failed: ${response.status()} ${await response.text()}`);
  const state = await (await request.get('/api/bootstrap')).json();
  if (state.recordingNoticeRequired === true && !state.recordingAccepted) {
    const notice = await request.post('/api/recording/acknowledge', { data: { version: 'recording-notice-v1', accepted: true } });
    if (!notice.ok()) throw new Error(`Test owner recording acknowledgment failed: ${notice.status()} ${await notice.text()}`);
  }
  return (await request.get('/api/bootstrap')).json();
}
