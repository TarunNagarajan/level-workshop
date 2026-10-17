# The Langley Window: art and media

## Setting and reference

The playable image is an original generated field-rig plate based on an actual frame of Luther in the fire truck in Mission: Impossible (1996). The supplied reference shows black portable computers, red firefighting plumbing and the vehicle's utilitarian metal interior. The new view places the player at the operator's seat, with the equipment temporarily arranged on a worn board over transport cases. A phone, headset, papers and connected leads occupy the remaining space. Daylight enters through an open side hatch.

The actual image input is the [Luther fire-truck frame](https://www.listal.com/viewimage/7476367). The [final shooting screenplay](https://www.dailyscript.com/scripts/mission-impossible_shoot.html) corroborates the vehicle setting and the portable computers, phone cable and manuals. Reference preparation remains private; the actor's image is not shipped as gameplay art. The earlier graphite and beige-office plates were rejected and are superseded.

The built-in image generation tool received the actual Mission: Impossible frame as its reference. It generated the empty reverse view with no people, hands, faces, logos or interface text. This is a generated adaptation, not a photograph or a claim that this exact arrangement appears in the film. The full final prompt is included in mission-art-prompt.txt. The generated PNG is converted to WebP without changing its composition. The service and extraction disks were regenerated using the exact final background as their camera, material and lighting reference. The extraction disk also used the new service disk as its companion reference. Both are flat, foreshortened black plastic with dull shutters and faded blank labels, carrying a small orange or green marker. A short contact shadow is part of each transparent image; no large CSS shadow lifts them off the surface. The generated alpha is preserved during WebP conversion. The final cutout prompts are included in mission-service-disk-v2-prompt.txt and mission-extraction-disk-v2-prompt.txt.

## Live interface geometry

workstation-v3.webp is1672 by941 pixels. Main glass is approximatelyx615–1103,y165–496. The safe live terminal rectangle isx628,y180,width466,height305. The whole image plane and its live interface must share these coordinates during resizing and focus, preserving the1672:941 aspect ratio. The main device is a portable field terminal. Its retro effects are a browser presentation choice for the game.

The cassette-recorder hotspot coversx90–365,y440–550. Service disk is placedx185,y650,width112, on the notebook. Extraction disk isx1040,y739,width112, on the clear board below the keyboard. The film's final plate uses the same placements and the exact service-disk-v2.webp and extraction-disk-v2.webp cutouts as the live scene. At 112 pixels wide in source coordinates, the natural heights are approximately 60 and 63 pixels, rather than upright square props. Small screens have a focused view with readable text and a composer that remains inside the visible glass.

## Opening film and audio

mission-intro-v4.mp4 contains24 seconds, source time4–28 seconds, from the official Movieclips upload [Into the Vault, Mission: Impossible (1996)](https://www.youtube.com/watch?v=k-oVuQpjG3s). The publisher's in-picture credit is retained. Copyright in the original film remains with its rights holders; the game does not claim endorsement or ownership of those excerpts.

A0.6-second fade through black joins that excerpt to a6.6-second hold of the original field rig and its two movable disks. Total running time is30 seconds. The application holds the final frame until the saved round is ready, then displays the live interface in the same scene. No YouTube player is used at runtime.

The source footage is1280x720 at approximately23.98fps. Export is1920x1080 H.264/yuv420p at30fps, with AAC stereo48kHz and MP4 faststart. This is an upscaled1080p export, not native4K. Hosting the file locally removes the external player interface; network latency still depends on the connection. The whole final video is decoded during verification.

mission-intro-v4.vtt contains original scene summaries, not a dialogue transcription. The summaries establish Ethan entering the vault, Luther supporting him from the fire truck, the protected NOC identity and the player's objective. mission-roomtone-v1.mp3 is an original synthesized low mechanical hum with filtered noise. It contains no commercial score or impersonated character voice.

## Runtime and provenance

The archive AI, NIGHTJAR record and conversational task are an original fictional adaptation. The player accesses the archive remotely from the truck. No protected name is painted into the image, hidden in a clue or distributed in frontend configuration. Text and controls are live accessible DOM elements over the blank display.

The separate Mission browser program includes its full corresponding source, upstream cool-retro-term revision, attribution, modification notes and GPL license in mission-client/. Those documents describe the actual browser effect adaptation. They do not relicense the film or make a legal determination about the host application.

mission-media-manifest.json records final byte counts, dimensions and SHA256 hashes. Raw downloader logs, signed media URLs, account metadata, provider credentials and private reference preparation must not be published.
