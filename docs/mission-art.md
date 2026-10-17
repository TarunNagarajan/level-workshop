# The Langley Window: art and media

## Direction and references

The playable desk is an original generated image, not a film still or a photograph of a real workstation. The first graphite equipment plate was rejected by the user for looking too synthetic. The replacement uses two actual film frames as image inputs: the team around the computer in **Sneakers (1992)** and David Lightman's desk in **WarGames (1983)**. The reference images informed the ordinary beige equipment, restrained exposure, practical light, and slightly uneven set dressing. Neither actors nor the reference compositions are reproduced in the gameplay image.

Reference pages: [Sneakers workstation](https://medium.com/@robertworkman_Disruptor/even-with-its-outdated-tech-the-1992-movie-sneakers-is-still-a-good-time-47a772a04162) and [WarGames workstation](https://wearethemutants.com/2016/12/15/falkens-maze-game-theory-computer-science-and-the-real-life-cold-war-inspirations-for-wargames/). Reference stills are kept in private production preparation, not shipped as game assets.

The built-in image generation tool was used with both reference files supplied directly. The production prompt asks for an empty, ordinary technical workroom in 1996, cream ABS CRT and coherent keyboard, grey laminate desk, cassette recorder on the left, dual disk unit on the right, soft side light, modest film texture, and blank dark screen. It excludes people, hands, neon, glowing screen outlines, server-rack symmetry, glossy gamer equipment, generated interface text, logos and decorative cables. The generated PNG is converted to WebP without changing the composition. The separate service and extraction disks are original generated transparent cutouts; the renderer preserves their alpha channel.

## Playable image coordinates

`workstation-v2.webp` is 1672 by 941 pixels. Safe live terminal rectangle: x581, y203, width542, height348. This lies inside the glass rather than on the bezel. Cassette play region centers around160,677. Upper drive opening is x1368–1530,y618–631; lower is x1368–1530,y687–701. Loose service disk is placed x140,y760,width150; extraction disk x1400,y760,width150. These placements also appear in the film's final plate. Responsive overlays must use the same image coordinate system and provide a readable terminal focus view on small screens.

## Opening film

`mission-intro-v2.mp4` contains a 24-second excerpt, source time4–28 seconds, from the official Movieclips upload [Mission: Impossible (1996), Into the Vault](https://www.youtube.com/watch?v=k-oVuQpjG3s). The publisher's in-picture credit is retained. This is existing film footage, not newly generated footage, and its copyright remains with the original rights holders. Use of the clip does not imply endorsement or a transfer of rights. The final shot is a6.6-second original workstation hold, joined by a0.6-second fade through black, for a total30-second opening. The hold includes the same two disk placements as the initial playing screen. The game must keep this frame visible until its actual saved round is ready.

The source is1280×720 at approximately23.98fps. The export is1920×1080 H.264/yuv420p at30fps, with AAC stereo48kHz and MP4 faststart. It is an upscaled1080p export, not native4K. Local hosting removes the YouTube player interface; it does not promise zero network latency. The final file is fully decoded as a verification step, not checked only by its first frame.

`mission-intro-v2.vtt` provides five original context summaries. They are not a transcription of the film dialogue. `mission-roomtone-v1.mp3` is an original synthesized low mechanical hum and filtered noise, with no commercial score or character-voice imitation. Its production source is deterministic. The film's source audio fades into this room tone at the workstation handoff.

## Source and runtime boundaries

The conversational archive AI, NIGHTJAR record and interactive terminal are a fictional playable adaptation; they are not claimed as computer software present in the1996 film. No protected identity is painted into an image, encoded into a clue or shipped in a frontend configuration. Interface text and controls are live DOM elements over the empty screen, not generated text baked into a bitmap.

The standalone Mission client carries its own cool-retro-term source acknowledgements, source revision, modification notes and GPL license under `mission-client/`. Those documents describe the actual browser effect adaptation. This art note does not relicense the source film or assert a legal conclusion about the host application.

## Final assets

The paired JSON manifest records exact byte sizes, dimensions and SHA256 hashes. Keep it current if the actual media changes. Do not publish raw download logs, signed media URLs, provider credentials, private reference preparation or source-account metadata.
