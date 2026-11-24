# Third-party notices

ffmpegnodes is licensed under the MIT License (see `LICENSE`). This file lists third-party material it contains or uses.

## FFmpeg documentation

`src/docs/filterDocs.json` and `src/docs/optionDocs.json` contain text taken from FFmpeg's documentation: `doc/filters.texi`, `doc/encoders.texi`, `doc/codecs.texi` and `doc/ffmpeg.texi`. The FFmpeg release the text comes from is recorded in each file's `ffmpeg` field. `scripts/gen-docs.ts` generates both files.

This text is part of FFmpeg, which is licensed under the GNU Lesser General Public License, version 2.1 or later (LGPL-2.1-or-later). It is not covered by the MIT License of this project. The original sources are available at https://github.com/FFmpeg/FFmpeg/tree/master/doc and https://ffmpeg.org/.

## FFmpeg itself

ffmpegnodes does not include, link or distribute FFmpeg. It runs the `ffmpeg` and `ffprobe` programs that the user installs separately. Those programs carry their own licenses (LGPL or GPL, depending on the build).

FFmpeg is a trademark of Fabrice Bellard. This project is not affiliated with or endorsed by the FFmpeg project.

## Libraries

The libraries the app is built with are under permissive licenses, mainly MIT and MIT OR Apache-2.0: React, @xyflow/react, zustand, Tauri and its plugins, and their dependencies. Their license texts ship with each package in `node_modules` and in the Rust crate sources.
