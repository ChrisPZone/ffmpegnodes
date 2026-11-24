# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Don't open a public issue.

Include what you found, how to reproduce it, and which version of ffmpegnodes you used. You'll get an answer as soon as possible.

## Supported versions

Only the latest release gets fixes.

## Scope

ffmpegnodes runs the `ffmpeg` and `ffprobe` you install and passes them argument lists, never a shell command line. Vulnerabilities in ffmpeg itself belong to the [FFmpeg project](https://ffmpeg.org/security.html).
