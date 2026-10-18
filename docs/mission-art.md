# The Langley archive: presentation and media

The playable view is the terminal itself. The room photograph, removable disks, capture controls and ejection sequence have been removed from the current experience. The player works as Luther Stickell, Ethan Hunt's technical specialist, and questions a remote archive AI about the redacted NIGHTJAR record. The AI and protected identity are original additions for the workshop scenario.

## Terminal treatment

The separate Mission browser program ports the rendering treatment from cool-retro-term at commit 1394ce82fa53d2a87d5adc4d99f9eeba598ea53d. It uses the Default Amber preset, the bundled Terminess font and original noise texture. Text is rasterized into a texture and processed by WebGL shader passes for curvature, phosphor persistence, bloom, signal noise, color and glass/frame response. It is not a photograph of a terminal or a transparent noise overlay on ordinary text. The source and modification notes are distributed under mission-client/ with the upstream license and font notice. Browser texture handling and native input are adaptations; the application does not run Qt or claim identical pixels on every GPU.

The bloom follows Qt FastBlur's downsample pyramid and weighted level composition, the effect used by the upstream QML. The Qt source reference is qt5compat commit 6c5a26d46016c652bf520aaff18a6d874d400e34, src/imports/graphicaleffects5/FastBlur.qml and shaders_ng/fastblur*. The original cool-retro-term Default Amber demonstration was used as the visual reference. Reduced motion removes the moving signal effects. A selectable DOM transcript and native editor remain available when graphics support is unavailable.

## Luther and the opening film

luther-stickell-v1.webp is an actual, unretouched film frame showing Luther working at his computer and radio during the Langley operation. No generated likeness is used. The opening now shows Luther at work, identifies him, shows Ethan in the vault, and explains that the player needs to obtain the real name behind NIGHTJAR by questioning the archive AI.

The film excerpts come from the official Movieclips upload [Into the Vault, Mission: Impossible (1996)](https://www.youtube.com/watch?v=k-oVuQpjG3s). Luther's shots are taken from approximately 103.8–105.8 and 110.8–112.8 seconds of that source. Ethan's shots use approximately 4–23.1 seconds. Brief holds let the original context captions remain readable. The publisher's in-picture credit is retained. The original footage remains the work of its rights holders; this game does not claim their endorsement or ownership of the film.

The final transition uses a capture of the actual browser CRT presentation, rather than the rejected room image. A fade through black joins the film to this screen. The same fullscreen root contains the video and game. A saved round and its four-minute timer start only when the introduction ends or the player skips it. The video is selfhosted with native playback; no YouTube player or external video embed is used at runtime.

mission-intro-v5.mp4 is a 30-second 1920x1080 H.264/yuv420p export at 30 fps, with AAC stereo 48 kHz, MP4 faststart and byte-range playback. The film source is 1280x720 at approximately23.98fps, so the export is upscaled 1080p, not native 4K. mission-intro-v5.vtt supplies original scene summaries and objectives, not dialogue transcription. mission-roomtone-v1.mp3 is an original synthesized mechanical hum. It contains no commercial score or impersonated character voice.

## Records and verification

The protected name and trusted instructions are server-only. New conversation-only sessions record an immutable interaction revision alongside their difficulty profile and model snapshot. Finishing seals the conversation and asks the reviewer to assess the full saved transcript. Historical sessions retain their original snapshot and equipment events; compatibility closure is recorded separately and does not invent ejection events.

mission-media-manifest.json records the shipped files, dimensions, byte counts and SHA256 hashes. The export is fully decoded during media verification, and the browser handoff is checked through actual playback. Raw download metadata, signed source URLs, credentials and private preparation files are excluded from deployment.
