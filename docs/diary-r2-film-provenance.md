# Diary introduction film excerpts

Prepared 17 October 2026 at the user's explicit request for locally hosted clips with no YouTube player overlay. Source: Harry Potter official channel, Harry Discovers Tom Riddle's Past | Chamber of Secrets, https://www.youtube.com/watch?v=AhefV0t5wSA. Footage is from Harry Potter and the Chamber of Secrets. The publisher's available source tops out at 1920 by 1080; these are not native 4K files.

Only the following short excerpts are included in the project, not the entire six-minute source or the film. The original framing and audio are retained. No visual watermark, credit or branding within the footage has been cropped or masked. Product controls and the source credit sit outside or in the browser's native video controls, without a YouTube embed or runtime request.

| Project file under static/diary-assets/film | Source interval | Actual duration | Bytes | SHA256 |
| --- | --- | --- | --- | --- |
| diary-awakens-r2-v1.mp4 | 43-63 seconds | 20.02 seconds | 5867827 | 4ad130047829a96eda58294a6612f9567f8bd9cf1cea936bdf4865ad0af76d9e |
| hagrid-accusation-r2-v1.mp4 | 289-304 seconds | 15.05 seconds | 2231091 | a117531d22b3a6b95ef92c6b411508a427624dab0ff077f8563fc176137d54bf |

Both files contain H264 High, yuv420p, 1920 by 1080 progressive video at 29.97 fps and AAC-LC stereo audio at 44.1 kHz. MP4 faststart places playback metadata before media data. They were cut using yt-dlp 2026.08.19 with Node challenge runtime and FFmpeg 7.1, then remuxed with faststart without another video encode. Root inspected decoded frames from each delivered file. The first shows Harry writing; the second shows Riddle approaching Hagrid. Neither contains YouTube controls in the image.

Each matching .vtt file contains an original concise English scene summary, not a verbatim dialogue transcript. Label it English scene summary or Scene descriptions. Do not label it verbatim subtitles. The accompanying short story text gives an accessible alternative when playback fails. These summaries do not disclose the protected answer.

Delivery uses versioned static URLs on the existing hosting. Preloading and browser/CDN caching reduce playback delay; an initial visit still requires a network transfer. Do not describe that as zero network latency or promise offline availability without an explicitly implemented offline cache. Future edits must receive new versioned filenames before immutable caching is applied.

## Continuous cinematic opening, 17 October 2026

The cinematic revision replaces the separate slides with one continuous local edit. The delivered file is `static/diary-assets/film/riddle-cinematic-r3-v1.mp4`: 60.00 seconds, 16,436,188 bytes, SHA256 `4c5170b42fdbfe9d1dde96be04a8e53287f768a603ad792cc40c4da62cef4229`. Its matching `.vtt` contains seven original English scene summaries, including the player's task near the end. These are scene descriptions, not dialogue subtitles. Earlier versioned excerpts remain intact for historical asset URLs.

The source remains the official Harry Potter publisher video linked above. Four passages appear in order: 43.00 to 64.90 seconds, where Harry writes and the diary answers; 106.00 to 119.00, where the diary invites him into its memory; 138.00 to 144.00, where Harry arrives in the past; and 288.90 to 309.20, where Riddle accuses Hagrid and Hagrid finishes his denial. Downloaded preparation files include a small boundary margin where needed, but only these intervals occur in the edit. The earlier fifteen-second accusation cut ended during a sentence; this revision keeps the complete response. No culprit reveal, orphanage motive, later-series disclosure, new dialogue, generated human likeness or new musical track was inserted.

Each join uses a 0.60-second fade through black, with a matching audio crossfade. This avoids the layered faces visible in the initial dissolve draft. Selected footage totals 61.20 seconds; subtracting 1.80 seconds of transition overlaps yields 59.40 seconds. A 0.35-second opening fade, final picture fade from 58.90 to 59.40 seconds and 0.60-second black tail give a 60.00-second finished sequence. Audio fades briefly at the opening and at the final cut, followed by silence during the tail. The application supplies the final transition to the actual playable diary desk. Original framing and in-picture credits are not cropped or masked.

FFmpeg 7.1 encoding: 1920 by 1080 H264/yuv420p at 30 fps, AAC stereo at 48 kHz and 128 kbps, CRF 22 with a 3.5 Mbps video ceiling, and MP4 faststart. The source is 29.97 fps; conversion to 30 fps normalizes timing and does not increase resolution. This is 1080p footage. One continuous file avoids player swaps and new media requests at edit points. Immutable browser/CDN caching applies to the new versioned URL; first visits still require transfer.

Root independently decoded the entire final export without errors, verified the duration, codec and dimensions, parsed MP4 atoms to confirm `moov` precedes `mdat`, calculated the hash above, and inspected frames at 4, 21.6, 28, 36, 45 and 58.8 seconds. Source auto-caption timestamps were consulted privately to avoid mid-sentence cuts; those captions are not shipped. Preparation scripts, unused excerpts and verification output remain outside the deployed app. Only the final hashed export is published.
