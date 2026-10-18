# CRT source and assets

The Mission client is a separate browser program distributed under GNU GPL version 3 or later. This directory contains the complete corresponding sources for the CRT rendering port and the original assets it uses.

The upstream GLSL and QML treatment is from cool-retro-term by Filippo Scognamiglio, commit `1394ce82fa53d2a87d5adc4d99f9eeba598ea53d`. Original source files are under `upstream/`; the browser WebGL2 adaptation is `../crt-renderer.js`. The port preserves Default Amber's parameter values, static-then-dynamic pass order, source noise, curvature, weighted channel sampling, bloom composition, flicker, jitter, and burn-in algorithm. Qt uniforms, render targets and FastBlur's multi-level downsampling are adapted to WebGL2. Browser output varies across GPUs and is not the native Qt application.

The bundled `allNoise512.png` is the cool-retro-term noise texture. The Terminess Nerd Font file is redistributed under SIL Open Font License 1.1; its license and reserved font names are stated in `fonts/LICENSE-Terminess.txt`.

The FastBlur shader sources are from Qt 5 Compatibility Graphical Effects, Qt commit `6c5a26d46016c652bf520aaff18a6d874d400e34`. The source identifies the available licensing choices as LGPL-3.0-only, GPL-2.0-only or GPL-3.0-only; this distribution uses GPL-3.0-only, compatible with this separately licensed Mission client. The Qt-derived source files are under `upstream/` and are attributed to The Qt Company Ltd.

The full GPL-3.0 license text is `upstream/GPL-3.0.txt`. The original cool-retro-term shader files are preserved unmodified alongside their QML pipeline sources. The port's modified source is distributed under GPL-3.0-or-later.
