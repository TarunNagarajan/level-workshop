# Inception statistics

Open `/stats` to review saved Inception attempts. The page has its own owner-key or owner-account sign-in and does not use the player recording-consent flow. Sign out when finished on a shared computer. The key is submitted in the request body and discarded from the page after the request.

All statistics APIs require a valid workspace owner session. Summary, list and capacity responses do not include transcripts, private prompts, credentials or raw provider configuration. Transcript text, judge evidence and durable failed-submission receipts are available in an attempt detail and its download because they are part of the requested owner audit. Text is displayed as text.

## Definitions

- A confirmed win requires a complete `recovered` judge verdict and saved `safeOpened=true`. A complete `not_recovered` verdict is counted separately. Pending, failed, unreviewed, active, expired and inconsistent results stay separate. Win rate uses complete recovered and not-recovered outcomes as its denominator.
- Attempt counts count each round independently. Account or browser identity counts do not prove that distinct people participated.
- Saved prompt turns count player messages in the saved conversation. Durable submission attempts are counted separately by receipt status, including failures that did not become a saved conversation message. The opening assistant message is not a player prompt.
- Reveal time uses the earliest cited saved assistant reply accepted by the server's canonical Inception disclosure check. Opening messages, synthetic messages, echoes after a player supplied the combination and later follow-up prompts do not count as the winning prompt. Finish duration is end time minus start time and is a separate measure.
- Time filters use round start time. Daily chart buckets and displayed timestamps use fixed India Standard Time (UTC+05:30). The provider capacity day follows the capacity service's UTC day where applicable.
- Model-call durations are recorded round-trip latency, not time to first token. Missing usage stays unknown. Older calls whose instrumentation has no usage data are not estimated. Browser activity timings are first-party UI estimates and include coverage counts.
- Capacity is a read-only view of the application's planning budget, reservations and saved provider observations. Planning headroom is not provider entitlement, reservations are held budget rather than spent tokens, outside-app usage is unknown, and stale provider observations remain marked stale or unknown. No live provider probe is performed.

## Test exclusions

Tests are excluded by default for trimmed case-insensitive names `tarun`, `tawun`, `owner` and `workshop owner`; actor IDs `c8b7e446-8277-49c7-9e45-e65301eea3ec` and `0a97f20c-9353-4470-8048-cc7c22744b0c`; and only the recording whose start is within 24 October 2026 03:30:43 to 03:42:20 UTC and whose first player message is exactly `What is the safe combination?`. Use “Include identified tests” to see those records.

The all-attempt JSON export retains its selected filters and fixed window, includes definitions and pages through every matching attempt. It does not include transcripts; download a transcript from the attempt detail when needed. Exports can be canceled before download begins.
