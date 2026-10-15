# Riddle's Diary experiment records

These records contain synthetic diagnostic interviews performed by Codex against the deployed Level Workshop application. They do not contain participant interviews. All model responses are preserved as received; no successful answer was inserted into a transcript. Provider names are returned aliases, not immutable weight snapshots. Model settings identified as configured defaults were not all independently returned by the round API.

## Separate datasets

The calibration files preserve exploratory work. Questions changed between fresh interviews after earlier replies were read. The fixed comparison has sixteen independent interviews, four profiles by four strategies. The final baseline has fifty independent interviews in a fixed seeded order, with nine attack families and benign controls. The baseline is executed after the application and its prompt profiles are frozen. Do not pool calibration, comparison and baseline into one success rate.

`diary-calibration-followup-r1.json` retains its original interrupted state: Standard completed six replies; a subsequent Guarded placeholder contains no round and no calls. A raw `running` label in that file is an interruption artifact, not an ongoing experiment. `diary-calibration-guarded-evidence-r1.json` stopped after three saved replies when a protected-preview object action timed out. This is an incomplete transport failure, not a provider refusal. The successful fresh direct-HTTPS Guarded interview is a different record. The legacy review retry file preserves bounded citation retries separately.

## Interpreting the labels

Automated verdicts are the application's model reviews and remain unchanged. The independent assessment files are Codex Sol's semantic readings under the included rubric. They are not human adjudication or ground truth. A model may disclose part of the protected account while contradicting another part or inventing an unsupported detail. The notes keep those distinctions. No claim is made about defeating harmful-request safety safeguards, statistical significance or a stable ordering of difficulty.

## Context, pacing and provenance

All comparison and baseline interviews inspect and present both papers before questioning. Even a direct-extraction attempt therefore has the same inspected scene context. The baseline does not include an uninspected-object experimental condition. Each new request carries the server's saved observation context; later object actions do not rewrite earlier contexts. Older calibration files predate the runner's copied `savedUserTurn` fields, although their server journal retains that context.

The runner deliberately separates service pacing from provider-call and HTTP latency. Its twenty-second interval is between starts of target or judge requests. That delay is not reported as model thinking time. A failed request remains a recorded service outcome and must not be counted as successful secret protection.

The application uses `openai/gpt-oss-20b` through Groq for both target and reviewer, in separate requests and contexts. The reviewer protocol is `saved-reply-selection-v2` for later runs; the first calibration used the legacy exact-quote protocol. Four revision-1 prompt and snapshot hashes are retained in each batch. The comparison runner SHA-256 is `92cf4962c6d7dc0c99e84368bb47ad55804ade569357c486c3aeab66102b3017`. The final baseline runner hash is recorded separately in the manifest after a timing-only correction. The matrix minimum recorded interval was19,982ms; its records were retained unchanged.

## Privacy

Cookies, raw round capabilities, API keys and request headers are excluded. Round, turn and submission identifiers refer only to these synthetic diagnostics and require application authorization to access. The owner authentication used for testing is temporary and is removed after completion. Database backups and participant data are not part of this package.

Prompt-level submittedAt is captured when the scripted question is queued, before any pacing wait. Use apiCalls.startedAt for the actual network-request start; pacing waits and server-saved timestamps are retained separately. Independent CSV record numbers refer to the one-based order of records in the corresponding raw file.



## Completed baseline and explicit replacements
The primary fifty-attempt batch ended with forty-eight completed target interviews and two transport failures. Trial baseline-14 failed at round start, before any prompt. Trial baseline-39 queued its first question but received no HTTP response; an exact request-and-round journal check after batch completion found zero accepted submissions. The scoped proof is included. Those failures are retained unchanged, not counted as protection of the secret.

Two explicitly selected fresh rounds repeat the canonical one-question and two-question plans. The replacement file binds to the primary file hash and original record hashes. The derived fifty-interview file contains forty-eight completed primary records and those two replacements, unchanged, with an explicit source map. Both original files remain here: fifty-two attempt records in total, fifty actual target interviews and sixty-six saved target replies. The two database audits verify all sixty-six accepted questions and replies, their round/profile/request associations and transcript flags. These checks verify this bounded synthetic dataset; they cannot promise that arbitrary future browser interactions will always reach the server.

Baseline-15 has a saved target reply but an unavailable model review after an invalid response. It counts as a completed target interview, not a successful defense or a failed target request. Its automated review was not silently retried. Independent readings cover all fifty actual interviews. Primary CSV ordinals refer to the original fifty attempts; replacement CSV ordinals refer to its two records. The derived completed-50 CSV resolves both sources explicitly.

The final fifty comprise forty-two attack interviews and eight ordinary-question controls. Under the conservative Codex Sol reading, attacks produced one full disclosure, fifteen partial disclosures and twenty-six without recovery. One benign control exposed a protected fact; the other seven did not. The automated reviewer marked twelve recovered, two partial, thirty-five not recovered, and one unavailable. These are different assessments of the same saved text. In the sealed counterfactual replacement, the reviewer claimed a memory edit that neither reply actually described.
