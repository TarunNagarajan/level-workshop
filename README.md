# Level workshop

Developers can now join through a reusable private workshop link and enter only their name. Open Team and choose Create workshop link. It lasts 30 days and can be revoked there; revocation also ends the author sessions issued through it. The browser remembers each developer. Names are attribution, not passwords; the invitation link grants editor access. Matching another person's name does not grant their permissions or ownership.

This directory contains the hosted source. The Vercel deployment uses Express with Neon PostgreSQL for persistent shared data. The earlier Sites deployment uses Cloudflare D1. An owner link handles hosted setup and owner access, so the public root cannot be claimed by a visitor. The model key and owner link credential are server secrets. Private blind play links remain separate from developer workshop links.

A web sandbox for authoring, testing and reviewing conversational challenges. React and Vite provide the interface. One Node/Express server stores the workspace in SQLite and calls GPT-OSS 20B through Groq. Reviews are manual; no judge is connected.

## Orchestration Lab

Open **Orchestration** in the sidebar to test instructions for a three-specialist workflow. A configuration contains a shared task and three independently editable specialist names, system prompts and temperatures. Save the draft, then save a numbered version when the configuration is worth keeping. Each test run freezes the prompts, shared task, test case and model used, so later edits cannot change the meaning of an earlier result.

In a run, ask each specialist questions in its own conversation. The three conversations stay separate. Use **Share** on a specialist reply to put that actual reply on the common board and choose which other specialists receive it. The board item is included in those specialists' next requests. **Inspect context** shows the exact system prompt and messages sent for a recorded reply. **Compare runs** places two test results and their prompt configurations side by side, making prompt changes and one-shot answers easier to spot. Runs and their board are saved for the team; only their tester or the workspace owner can continue one.

The first release uses the workshop's currently configured `openai/gpt-oss-20b` model for all three slots. The interface displays the model for every run. Specialist-specific model selection, Gemini integration and enforced differences in tools or private information are subsequent work. System prompts alone cannot guarantee a restricted capability; use the lab to observe that behaviour before choosing and enforcing the final model setup.

`node tests/live-orchestration-eval.mjs` repeats the model probes using the locally configured key and an in-memory database, writing private outputs into the ignored `verification/` directory. Set `ORCHESTRATION_STAGED_ONLY=1` to run only the information-handoff control.

## Run

Requires Node 22.13 or newer. From this directory:

```powershell
npm install
npm run build
npm start
```

Open http://127.0.0.1:4317. Create your owner account on the first visit. This seeds the Harry Potter, Mission: Impossible and Inception drafts from the project brief. These are starting scenarios to test and revise, not validated festival levels.

The server reads `GROQ_API_KEY` from its environment or a `.env` in this directory. An example is included in `.env.example`. An existing environment key takes precedence over the file. Credentials never enter the client bundle or test exports.

For development, `npm run dev` starts the backend on 4317 and the interface on 5173. Keep the production server stopped when using that command, since they use the same backend port.

## Author a level

Your first workspace visit offers a short tour of the actual library, editor, test panel and team controls. Completing or skipping it is saved against your account. **Quick tour** in the sidebar reopens it whenever needed. The guide uses an existing draft without changing it or making model calls.

1. Open a seeded level, duplicate one, or create a blank level.
2. Define its player briefing, natural protected truth, success requirements and opening message.
3. Write the character instructions. Choose **Deduction** for intentionally permitted clues, or **Jailbreak** for an instruction that protects the truth and its implications.
4. Configure the timer, response word target, temperature and optional hints.
5. Save the draft to persist edits. Save a version, with a short change note, to make those edits testable and shareable.
6. Start a test. Branch from any target reply, restart, or replay a saved conversation against the latest version. Branches retain the selected transcript prefix and get a fresh timer. Replays reuse only player prompts, generating new target replies.
7. Create a blind test link. Its player sees the briefing and conversation, with no author instructions or answer key. Links expire after seven days and can be revoked for new sessions.
8. Open **Tests** to review a conversation. Select target replies as evidence, then record a solved, partial or unsolved outcome with notes.

The server appends the character, protected truth, mode, clues, response length and text-only output contract to the authored system prompt. Variables `{{character}}`, `{{secret}}`, `{{clues}}` and `{{criteria}}` are supported in the authored prompt. **Inspect request** shows the compiled saved draft or the exact prompt and transcript snapshot for the active test. It excludes credentials and model reasoning.

Responses use a word limit instruction, not a hard truncation. Total completion tokens are capped at 2048. Each round allows up to 40 player prompts. The server enforces the deadline even if the browser clock changes. A final answer can be submitted after the conversation deadline, but the model stops accepting new turns. Failed provider calls leave the player's input available for retry and do not save a partial conversation turn.

## Work as a team

The owner generates reusable workshop links in **Team** and assigns levels in the editor's **Round** tab. Developers enter only their names. Authors can read team drafts, comment and review tests; only the assigned author or owner can edit a draft. Authors can duplicate a teammate's draft to explore their own variation. Only the owner can approve levels. Approval requires a saved version matching the current draft and a reviewed test of that version.

For a genuinely blind test, share the player link with someone who has not read the authoring material. Team accounts intentionally have access to the workshop's drafts.

Draft saves reject stale revisions rather than overwrite someone else's edits. Version snapshots are immutable. Editing a draft cannot change a previously shared version or active round. Active author previews resume after refresh; blind sessions resume in their original browser tab. Tests retain the model, prompt, opening, hints used, transcript and answer. The SQLite database persists sessions and reviews across server restarts.

## Share the workshop

The current default listens on this laptop only. To test with teammates on the same network, set `HOST=0.0.0.0` in the environment and restart. Open the app using the laptop's network address before creating invitation or player links; links use the address currently in the browser.

For remote use, the Vercel deployment uses Neon PostgreSQL and the same private developer link. The earlier Sites version uses Cloudflare D1. The owner capability and model credential are server secrets. The application gates author material using the private link and an opaque session cookie.

To back up, stop the server and copy `data/`. It contains author material, account hashes, invitations, versions and transcripts. Store backups privately. No API key is written there. The first-run owner flow has no email delivery or self-service password reset.

## Target configuration

### Vercel deployment

The root `app.mjs` is the Express entry. `npm run build:vercel` builds the React client into `public/`, served by Vercel's CDN. The server handles API endpoints and client routes. `DATABASE_URL`, `WORKSHOP_OWNER_KEY`, `WORKSHOP_SHARE_KEY` and `GROQ_API_KEY` belong in production environment variables. Set `PUBLIC_ORIGIN` to the production origin if using a custom domain. Missing database or capability credentials fail closed with a configuration message.

Apply PostgreSQL migrations with `npm run db:migrate` before deploying. Migration checksums prevent editing an already applied file; changes belong in a new SQL migration under `db/postgres/`. Atomic batches and database leases preserve the same concurrency rules as the D1 deployment. Timestamps remain numeric in the application. Source snapshots in `work/` contain private workspace data and are excluded from Vercel uploads and Git.

`scripts/export-sites.mjs` takes a source owner capability and native table snapshots through standard input. It fills the database viewer's truncated JSON cells through authorized reads. `scripts/import-postgres.mjs` refuses a populated target, imports the full snapshot in one transaction, then checks every field. These are one-time migration tools, not application routes. Users reenter through their private links on the new domain because browser cookies are scoped to their original host.

### Local configuration

| Environment variable | Default |
| --- | --- |
| `GROQ_API_KEY` | Required for real chat |
| `TARGET_API_KEY` | Optional alternative to `GROQ_API_KEY` |
| `TARGET_MODEL` | `openai/gpt-oss-20b` |
| `TARGET_BASE_URL` | `https://api.groq.com/openai/v1` |
| `PORT` | `4317` |
| `HOST` | `127.0.0.1` |
| `DATABASE_PATH` | `data/workshop.sqlite` |
| `PUBLIC_ORIGIN` | Request origin |
| `COOKIE_SECURE` | `false`; set `true` behind HTTPS |

A key being present means configured, not provider access verified. Run a test to confirm access. Provider errors and rate limits appear in the chat. The Groq adapter requests low reasoning effort and excludes reasoning for GPT-OSS. Other compatible providers can be configured through the environment; validate their supported completion parameters before switching.

## Verification

```powershell
npm test
npm run build
npx playwright install chromium
npm run test:ui
node tests/live-check.mjs
```

The API tests exercise auth, secret boundaries, immutable versions, revisions, session isolation, evidence requirements, author permissions, deadlines, revocation and failure recovery. Browser tests run the author-to-player-to-review flow using an isolated database and an explicit fixture model. Production has no fixture or simulated model switch. The separate live check calls the actual configured provider and records visible output and measured latency in `verification/live-model.json`.

Browser checks write screenshots and reports into the ignored `verification/` directory. Fonts are served locally. Motion is short and event-driven, with reduced-motion support.

Implementation references: [Groq compatibility](https://console.groq.com/docs/openai), [GPT-OSS reasoning parameters](https://console.groq.com/docs/reasoning), [Node SQLite](https://nodejs.org/api/sqlite.html).

## Interactive reference: One last passenger

Open `/reference` after entering the workshop. This completed object-only scene is separate from the three team themes. The player can move documents with pointer or keyboard, inspect and enlarge them, open/turn passport pages, request an arrival card, compare signatures, use a UV lamp, present objects, interview a real target model, keep replies as evidence, and stamp HOLD or CLEAR. The five-minute deadline is enforced on the server. A stamp records a finding; manual review determines disclosure.

The author’s Explore the design view contains six storyboard beats, object roles, current model context, saved action trail, success criteria, and a six-step build guide. Create my editable prompt draft makes a separate authored level; it does not duplicate the physical scene implementation. Share issues a seven-day name-only blind link without author controls. The owner can revoke links in that dialog. Existing round capabilities remain independently usable to finish a started case.

`server/passport-reference.mjs` defines the fixed reference, bounded actions, observed-context compiler and routes. `src/PassportReference.tsx` and `src/passport.css` implement the desk and guide. Scene state is saved in `passport_sessions`, created by PostgreSQL migration `0003.sql` and the equivalent local/D1 schema. Round creation, scene actions and filing use atomic batches; all mutations share the round lease. Each model question stores its exact desk facts alongside the actual transcript. Tests export the inspected state and player-selected evidence for manual review. The finished reference remains fixed; authored copies are editable.

Artwork provenance and generation prompts are in `docs/passport-art.md`. Raster source assets live in `static/reference-assets/`; `public/` is generated build output. Names, dates, signatures and functional stamps are rendered as crisp interface text. No images of people are used.

`tests/passport.test.mjs` verifies context reconstruction, secrecy, capability access, version separation, concurrency, provider failure, deadlines and filing. `tests/browser/passport.spec.ts` verifies dragging, inspection, comparison, interviewing, evidence, the author guide and blind mobile refresh. `tests/live-passport-eval.mjs` exercises the actual configured model in an isolated database; it records samples, not a reliability guarantee.
