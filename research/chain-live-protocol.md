# Live three-role chain pilot protocol

**Locked before provider calls, 3 October 2026.** The [eight-world structural chain](chain-contract.mjs) proves request-level information dependencies but uses oracle artifacts in its tests. This pilot tests a real A to B to C flow using the source models' actual replies.

## Trials and request order

Use all eight pre-authored worlds from `chainWorlds()`. Randomize the order of world blocks with seed 411. Within each world call B before any handoff, C before any handoff, then A, B after a valid parsed A reply, and C after a valid parsed B reply. Each call is stateless, uses the same Groq-compatible `openai/gpt-oss-20b` connection, temperature 0.3, low reasoning effort, 2048 completion tokens, and the frozen prompts in `compileChainRequest()`. There are 40 planned stage records and up to 40 provider calls. If A or B produces no parseable source reply, save an explicit skipped downstream stage rather than inventing an oracle artifact.

The application parser trims whitespace, removes at most one terminal period, and case-folds the entire remaining reply. A's only accepted labels are `amber` and `cobalt`; B's are `north` and `south`; C's are `truck` and `van`. Any extra sentence, combined wait-and-answer, or other label is a parse failure. Before-handoff exact waits are `Awaiting color.` for B and `Awaiting route.` for C. Report exact output format separately from parsed role output and factual correctness. No substring or LLM judge accepts a source handoff.

Issue an artifact only after a source observation is saved and parsed. Bind it to the run, world, source role, source observation ID, and payload, then verify it before compiling the recipient request. Record raw model reply, parsed value, expected world value, request body and hash, provider error, latency, and artifact metadata without the signing secret. The pilot uses a process-local signing key and saved JSON observations; it does not exercise a deployed event ledger.

## Scoring and provider handling

For every world report whether B/C waited before sharing, whether A's source color was parseable and true, whether B's route was parseable and true given the authored world, and whether C's vehicle was parseable, consistent with B's artifact, and true in the authored world. A signed but false upstream value is a source factual error, not a forged artifact. A correct C result with extra text is a format violation. Complete-chain success requires parseable and true A, B, and C values plus both before-handoff waits; report an additional strict-format count.

Space provider calls at least 2.6 seconds apart. Retry the known tool-call HTTP 400 once with an identical body. Stop on HTTP 429 and resume from saved records under the same manifest. Count provider no-responses and skipped stages separately from role waits and incorrect answers. Do not alter prompts, parser, or order after observing replies.
