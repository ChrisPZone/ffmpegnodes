import { describe, expect, it } from "vitest";
import { describeStream, fmtBytes, fmtDuration, OutputInfoParser, parseProgress, splitPath, timeLeft } from "./jobInfo";

// Real ffmpeg 8 stderr (-hide_banner): an encode, where "Press [q]" comes before the output block.
const ENCODE = `Input #0, lavfi, from 'testsrc2=s=640x360:r=30:d=1':
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0: Video: wrapped_avframe, yuv420p, 640x360 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 30 tbn
Input #1, lavfi, from 'sine=d=1':
  Stream #1:0: Audio: pcm_s16le, 44100 Hz, mono, s16, 705 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (wrapped_avframe (native) -> hevc (libx265))
  Stream #1:0 -> #0:1 (pcm_s16le (native) -> aac (native))
Press [q] to stop, [?] for help
Output #0, mp4, to 'C:\\videos\\o1.mp4':
  Metadata:
    encoder         : Lavf63.18.100
  Stream #0:0: Video: hevc (hev1 / 0x31766568), yuv420p(tv, progressive), 640x360 [SAR 1:1 DAR 16:9], q=2-31, 30 fps, 15360 tbn
    Metadata:
      encoder         : Lavc63.25.102 libx265
    Side data:
      CPB properties: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A
  Stream #0:1: Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 128 kb/s
    Metadata:
      encoder         : Lavc63.25.102 aac
[out#0/mp4 @ 0000021fe11b3380] video:66KiB audio:15KiB`;

// Stream copy into mkv, plus a second output with subtitles; "Press [q]" after the output block.
const COPY = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'o1.mp4':
  Stream #0:0[0x1](und): Video: hevc (Main) (hev1 / 0x31766568), yuv420p(tv, progressive), 640x360 [SAR 1:1 DAR 16:9], 543 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
Output #0, matroska, to 'o2.mkv':
  Metadata:
    encoder         : Lavf63.18.100
  Stream #0:0(und): Video: hevc (Main) (hev1 / 0x31766568), yuv420p(tv, progressive), 640x360 [SAR 1:1 DAR 16:9], q=2-31, 543 kb/s, 29.97 fps, 30 tbr, 1k tbn (default)
  Stream #0:1(und): Audio: eac3 ([255][0][0][0] / 0x00FF), 48000 Hz, 5.1(side), fltp, 640 kb/s (default)
Output #1, srt, to '/tmp/subs.srt':
  Stream #1:0(eng): Subtitle: subrip (srt)
Press [q] to stop, [?] for help`;

const feedAll = (text: string) => {
  const p = new OutputInfoParser();
  for (const l of text.split("\n")) p.feed(l);
  return p;
};

describe("OutputInfoParser", () => {
  it("reads output files and encoded streams, ignoring input streams", () => {
    const p = feedAll(ENCODE);
    expect(p.files).toEqual([{ index: 0, format: "mp4", path: "C:\\videos\\o1.mp4" }]);
    expect(p.streams).toHaveLength(2);
    expect(p.streams[0]).toMatchObject({ output: 0, index: 0, media: "video", codec: "hevc", pixFmt: "yuv420p", width: 640, height: 360, fps: "30" });
    expect(p.streams[0].profile).toBeUndefined();
    expect(p.streams[1]).toMatchObject({ media: "audio", codec: "aac", profile: "LC", sampleRate: 44100, channels: "mono", bitrate: "128 kb/s" });
  });

  it("handles copies, language tags, several outputs and subtitles", () => {
    const p = feedAll(COPY);
    expect(p.files.map((f) => f.path)).toEqual(["o2.mkv", "/tmp/subs.srt"]);
    expect(p.streams[0]).toMatchObject({ codec: "hevc", profile: "Main", fps: "29.97", bitrate: "543 kb/s" });
    expect(p.streams[1]).toMatchObject({ codec: "eac3", channels: "5.1(side)", sampleRate: 48000 });
    expect(p.streams[1].profile).toBeUndefined();
    expect(p.streams[2]).toMatchObject({ output: 1, index: 0, media: "subtitle", codec: "subrip" });
  });

  it("does not take stream flags for a profile", () => {
    const p = feedAll(`Output #0, matroska, to 'o.mkv':
  Stream #0:3(eng): Subtitle: hdmv_pgs_subtitle (default)
  Stream #0:4(ger): Subtitle: hdmv_pgs_subtitle (default) (forced)`);
    expect(p.streams.map((s) => s.profile)).toEqual([undefined, undefined]);
    expect(describeStream(p.streams[0])).toEqual(["hdmv_pgs_subtitle"]);
  });

  it("describes streams in one line", () => {
    const p = feedAll(ENCODE);
    expect(describeStream(p.streams[0])).toEqual(["hevc", "640×360", "30 fps", "yuv420p"]);
    expect(describeStream(p.streams[1])).toEqual(["aac LC", "44.1 kHz", "mono", "128 kb/s"]);
  });
});

describe("parseProgress", () => {
  it("converts a progress block", () => {
    const r = parseProgress(
      { frame: "300", fps: "59.94", bitrate: " 708.5kbits/s", total_size: "1048576", out_time_us: "10000000", speed: "3.12x", dup_frames: "0", drop_frames: "2", progress: "continue" },
      40,
    );
    expect(r).toMatchObject({ outTime: 10, progress: 0.25, speed: "3.12x", speedX: 3.12, fps: "59.9", bitrate: "708.5 kb/s", totalSize: 1048576, frame: 300, dropFrames: 2 });
  });

  it("copes with N/A and an unknown duration", () => {
    const r = parseProgress({ out_time_us: "N/A", speed: "N/A", bitrate: "N/A", total_size: "N/A" });
    expect(r.outTime).toBeUndefined();
    expect(r.progress).toBeNaN();
    expect(r.speed).toBeUndefined();
    expect(r.bitrate).toBeUndefined();
  });
});

describe("timeLeft", () => {
  it("uses the speed", () => expect(timeLeft(100, 40, 2, 20)).toBe(30));
  it("falls back to the average rate", () => expect(timeLeft(100, 50, undefined, 10)).toBe(10));
  it("is unknown without a duration", () => expect(timeLeft(undefined, 50, 2, 10)).toBeUndefined());
});

describe("formatting", () => {
  it("formats durations, sizes and paths", () => {
    expect(fmtDuration(83.4)).toBe("1:23");
    expect(fmtDuration(3723)).toBe("1:02:03");
    expect(fmtDuration(undefined)).toBe("–");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.50 KB");
    expect(fmtBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(splitPath("C:\\videos\\out.mp4")).toEqual({ name: "out.mp4", dir: "C:\\videos" });
    expect(splitPath("out.mp4")).toEqual({ name: "out.mp4", dir: "" });
  });
});
