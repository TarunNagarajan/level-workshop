# Owner metrics API

All routes below are under `/api`. Owner reads require the existing `admin` role; editors and anonymous visitors cannot read metrics. The browser collector is first-party, best effort, and returns no owner, provider, collection, profile, or model identity. Metrics are never used to infer model quality or jailbreak success. The nonstreaming adapter provides request round-trip time, not time-to-first-token or generation-only speed.

## Browser session and event collection

`POST /telemetry/session` sets a random HttpOnly, SameSite=Strict cookie (`Secure` on hosted HTTPS), stores only its hash, and returns `{enabled,heartbeatSeconds,idleAfterMs}`. Session idle expiry is 30 minutes and maximum lifetime is 24 hours. A change in authenticated user closes the old session and starts a fresh one; the linked user ID is stored without duplicating a name or email. New anonymous sessions are rate-limited to 120 per minute per transient network key; the key is held only in process memory and is never persisted. With metrics disabled the route remains a no-op and returns `{enabled:false,heartbeatSeconds:0,idleAfterMs:0}`. Event and session records persist for owner review/export; there is no automatic deletion. Cookie lifetime, event batch size, and ingestion rate are bounded.

`POST /telemetry/events` accepts `{events:[Event]}` with 1–50 events. Every event requires UUIDv4 `eventId`, `tabId`, and `pageId`, plus `kind` and `view`. Event IDs are idempotent. A request may scope all events to one `roundId`; round-scoped events must include the normal `x-round-token` header. The server verifies the token against the round, then infers round, source, profile, and version from stored records. Neither token nor capability is stored. Do not mix round IDs in a batch.

The exact event fields are:

| Field | Type and values | Required |
| --- | --- | --- |
| `eventId`, `tabId`, `pageId` | UUIDv4 strings | Yes |
| `kind` | `page_enter`, `page_exit`, `heartbeat`, `visibility`, `phase`, `request`, `interaction` | Yes |
| `view` | `workshop`, `collect`, `passport`, `orchestration`, `editor`, `tests`, `settings`, `other` | Yes |
| `roundId` | UUID string | Round-specific events only; then required for every event in batch |
| `phase` | `read_think`, `compose`, `waiting`, `idle`, `hidden` | For `kind=phase` |
| `elapsedMs`, `activeMs`, `visibleMs`, `idleMs` | Integer milliseconds, each 0–86,400,000 | Optional interval measurements |
| `readThinkMs`, `composeMs`, `waitingMs`, `sinceReplyMs` | Integer milliseconds, each 0–86,400,000 | Optional interval/round measurements |
| `requestCategory` | `navigation`, `round_action`, `authoring`, `review`, `other` | For `kind=request` |
| `requestOutcome` | `success`, `error`, `retry` | For `kind=request` |
| `requestWallMs` | Integer milliseconds, 0–600,000 | For `kind=request` |
| `retryCount` | Integer, 0–20 | Optional request measurement |
| `interaction` | `hint`, `submit`, `finish` | For `kind=interaction` |

No arbitrary metadata, raw path/URL, message text, key event, IP, fingerprint, cookie, or capability fields are accepted. `activeMs <= visibleMs <= elapsedMs`; hidden intervals have zero active and visible duration; idle time cannot exceed visible time; `readThinkMs + composeMs + waitingMs <= activeMs`. Durations use `performance.now()` deltas. Idle means no tracked interaction for 30 seconds. The client infers reading/thinking from focus, input, and request lifecycle; the measure does not distinguish cognitive states. Heartbeats are expected every 15–20 seconds, with hide/page-exit flushes best effort. Hidden tabs do not accumulate active or visible time. Batches are limited to 50 events and 200 accepted events per session per minute. Invalid or oversized batches receive `400`/`429`; a collector failure never changes a normal page API result.

## Owner query window and pagination

Owner reads accept numeric epoch-millisecond `from` (inclusive) and `to` (exclusive). The default is the prior 30 days; maximum is 365 days. Invalid or inverted windows return `400`. Sample endpoints use integer `limit` from 1–200 and opaque `cursor`; they return `{items,limit,nextCursor,window}`. A cursor preserves its original window cutoff so later writes do not shift subsequent pages. Exports have no hidden row ceiling: request pages until `nextCursor` is `null`.

## Summary response

`GET /metrics/summary?from=...&to=...` returns this stable top-level shape (all duration values are milliseconds):

```json
{
  "window": {"from": 0, "to": 0},
  "instrumentationStartedAt": 0,
  "firstRecordedAt": 0,
  "coverage": {
    "modelCalls": {"recorded": 0, "roundsWithoutCalls": 0},
    "rounds": {"withCalls": 0, "withoutCalls": 0},
    "browserIntervals": {"timed": 0, "missing": 0}
  },
  "visits": {"sessions": 0},
  "browser": {
    "sessions": 0, "events": 0,
    "activeMs": null, "visibleMs": null, "idleMs": null,
    "readThinkMs": null, "composeMs": null, "waitingMs": null,
    "timedIntervals": 0, "missingIntervals": 0
  },
  "modelCalls": {
    "total": 0, "succeeded": 0, "failed": 0, "interrupted": 0,
    "inferredRetries": 0, "latency": {"count": 0, "meanMs": null, "minMs": null, "maxMs": null, "p50Ms": null, "p90Ms": null, "p95Ms": null},
    "tokens": {
      "input": {"sum": null, "covered": 0, "missing": 0},
      "output": {"sum": null, "covered": 0, "missing": 0},
      "total": {"sum": null, "covered": 0, "missing": 0}
    },
    "response": {"chars": 0, "words": 0}
  },
  "rounds": {"started": 0, "submitted": 0, "active": 0, "abandoned": 0, "hints": 0, "questions": 0, "diagnostics": {"started": 0, "submitted": 0, "active": 0, "abandoned": 0, "hints": 0, "questions": 0}, "bySource": [{"source": "participant", "started": 0, "submitted": 0, "active": 0, "abandoned": 0, "hints": 0}]},
  "routes": [{"view": "workshop", "sessions": 0, "events": 0, "activeMs": null, "visibleMs": null}],
  "bySource": [{"source": "participant", "calls": 0, "succeeded": 0, "failed": 0, "interrupted": 0, "inferredRetries": 0, "rounds": 0}],
  "byModel": [{"model": "", "calls": 0, "succeeded": 0, "failed": 0, "interrupted": 0, "latency": {"count": 0, "meanMs": null, "p50Ms": null, "p90Ms": null, "p95Ms": null}}],
  "byProfile": [{"source": "participant", "profileId": "", "calls": 0, "rounds": 0}]
}
```

The zeroes above show field types only. A nullable measurement with no covered observations is `null`, not zero. `instrumentationStartedAt` is the earliest metrics row across the retained dataset; `firstRecordedAt` is the earliest metrics row in the selected window. `coverage.rounds.withoutCalls` counts all rounds without a recorded model call; some may not require a call, so it is not a count of missing telemetry. Browser intervals missing timing are counted as missing. Token `sum` remains `null` when no value is known and each token field has covered/missing counts. Percentiles use nearest-rank p50/p90/p95. `rounds` counts blind participant rounds only; author previews, branches, replays, and local reference research runs appear under `rounds.diagnostics` and per-source rows. Model-call source breakdown distinguishes participant, preview, diagnostic, branch, replay, and orchestration activity; participant denominator excludes author diagnostics. Missing participant reviews are not classified as failures. `abandoned` uses authoritative submission/deadline state. Duration is projected from the stored round deadline field in SQL; transcripts and prompts are not loaded for summary. Response character/word counts describe returned visible text only.

## Session and call samples

`GET /metrics/sessions?...` returns `{items,limit,nextCursor,window}`. A session item is:

```json
{"sessionId":"uuid","createdAt":0,"lastSeenAt":0,"closedAt":null,"userId":"uuid-or-null","tabCount":1,"pageCount":1,"events":0,"activeMs":null,"visibleMs":null,"idleMs":null,"readThinkMs":null,"composeMs":null,"waitingMs":null,"routeUsage":[{"view":"workshop","events":0,"activeMs":null,"visibleMs":null}],"rounds":[{"roundId":"uuid","source":"participant","versionId":"safe-id","startedAt":0,"submittedAt":null,"hints":0,"questions":0}],"coverage":{"timedIntervals":0,"missingIntervals":0}}
```

`GET /metrics/calls?...` returns the same page envelope. A call item is:

```json
{"callId":"uuid","context":{"kind":"round","roundId":"uuid-or-null","runId":"uuid-or-null","lane":"safe-enum-or-null","userId":"uuid-or-null","userRole":"admin-or-editor-or-null","collectionId":"uuid-or-null","profileId":"safe-id-or-null","source":"participant-or-preview-or-branch-or-replay-or-orchestration-or-null","versionId":"safe-id-or-null"},"startedAt":0,"completedAt":0,"latencyMs":0,"requestedModel":"model-id","returnedModel":"model-id-or-null","providerHost":"api.example","status":"succeeded-or-failed-or-interrupted","errorCategory":"rate_limited-or-timeout-or-unavailable-or-auth_or_config-or-empty_response-or-transport_or_provider-or-null","tokens":{"input":null,"output":null,"total":null},"response":{"chars":0,"words":0},"retry":{"inferred":false,"retryOfId":null},"transcriptSaved":false}
```

Retries are inferred only when the same trusted round/run/lane and SHA-256 completion-body fingerprint repeat after a failed/interrupted call in the bounded matching window. The fingerprint and request body are never returned. A repeated successful conversation turn with changed context is not a retry. Calls have no prompts, transcript, raw request context, API key, cookie, capability, account name/email, IP, or raw URL. Provider identity is limited to requested/returned model identifiers and hostname.

## Safe export

`GET /metrics/export?limit=100&cursor=...&from=...&to=...` returns `{schema:"owner-metrics",schemaVersion:1,window,items,nextCursor,pageLimit}`. Each item has `type` (`event`, `model_call`, or `session`), `id`, `recordedAt`, and only the allowlisted fields represented in the session/call shapes above; events include bounded enum fields and durations but no arbitrary client payload. Export omits names/emails, IP, private paths, credentials, cookie values, capabilities, request bodies, prompts, and conversation text. The owner can cancel a multi-page download without changing stored records.

## Server call records

Server instrumentation covers every configured completion call: ordinary conversation, passport, collection, and orchestration. It writes a started row and then a success, failure, or interrupted outcome. Each record includes adapter round-trip duration, requested/returned model, provider hostname, stable error category, nullable input/output/total token counts, response character/word counts, and trusted call-site context. Stale started rows are reconciled as interrupted/unknown, never success. Logging is awaited where useful but always best effort: storage failures cannot suppress a valid provider result or change the normal API response. Existing collection provider records retain their exact request provenance and atomic transcript behavior.
