# NIGHTJAR: approach, terminal, retrieval

The player is Ethan Hunt at the Langley terminal. NIGHTJAR is a fictional classified source file; the objective is to make the archive AI disclose its protected full name in four minutes. The menu states this directly and keeps the four difficulty choices. There is no main-menu portrait, equipment puzzle or separate password to guess.

## Film edit

The eighteen-second introduction moves from Ethan approaching the vault to Ethan at the computer, then fades through black into a capture of the actual playable CRT. Three short caption cues establish the player, the file and the objective. The round and its timer begin after this film ends or is skipped.

The eighteen-second success ending uses real footage of Ethan operating the computer, the NOC copy display and Ethan's reaction. Original captions connect the game outcome to the scene: NIGHTJAR retrieved, the file secured, mission complete. The footage depicts the film's data retrieval; the archive AI and NIGHTJAR identity are additions for this workshop scenario. No film-native password or screen has been altered to pretend it contains the game's secret.

Both edits use official Movieclips uploads from Mission: Impossible (1996): [Into the Vault Scene (4/9)](https://www.youtube.com/watch?v=k-oVuQpjG3s) and [Close Call Scene (5/9)](https://www.youtube.com/watch?v=ar0xLps7WSY). The introduction uses source seconds 3–11 of Into the Vault and 0.2–4.7 of Close Call. The ending uses Close Call 2.5–12.5, 23.8–27.2 and 20.5–23.1, followed by a short held reaction and fade to black. The original film remains credited to its creators and Paramount; this workshop does not claim ownership or endorsement.

The source files are 1280x720. Their active picture is cropped to the even 1280x528 rectangle at 0,96, excluding the marked source letterbox, then scaled proportionally and padded to 1920x1080. The new edit therefore has a clean lower border without stretching the film or covering it with a UI patch. The export is upscaled 1080p, not native 4K. Both films use H.264/yuv420p at 30 fps, AAC stereo 48 kHz, MP4 faststart and native byte-range playback. There is no YouTube player at runtime. Source sound is retained; the intro's final terminal bridge uses the workshop's original synthesized room tone. No new commercial score or generated actor voice is added.

## Success presentation

Complete mission seals the saved conversation and runs the existing independent review. Only a server-confirmed complete/recovered result can trigger the success film. The terminal remains visible while retrieval is checked, then the same fullscreen root contains the transition and ending. The raw judge verdict and evidence do not interrupt a successful playthrough. Completion, replay, saved transcript, new mission and return remain available afterward.

Playback has explicit mute/play/retry/skip recovery for browser autoplay restrictions or unavailable media. Seeing or replaying an ending does not make another target or judge request. The playback marker is scoped to the member and round, and cannot turn a failed server result into a win. Existing historical records keep their original snapshot and player role. New rounds freeze Ethan as the player in profile revision 2; old records infer Luther when role metadata is absent.

## CRT and provenance

The existing WebGL2 browser port of cool-retro-term remains the playable display: original Default Amber equations, Terminess font, noise, static curvature/bloom and dynamic phosphor/glass/frame treatment. Upstream commit 1394ce82fa53d2a87d5adc4d99f9eeba598ea53d and Qt FastBlur reference 6c5a26d46016c652bf520aaff18a6d874d400e34 remain attributed with distributed source and licenses under mission-client/crt. Browser adaptation does not imply native Qt pixel identity.

mission-media-manifest.json records the exact file hashes, dimensions, timing and source cut ranges. Both complete films are decoded during verification, including the final video frames; sampled film frames are checked for the clean lower border. Private download metadata, signed source URLs, credentials and media preparation files are excluded from deployment.
