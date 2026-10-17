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
