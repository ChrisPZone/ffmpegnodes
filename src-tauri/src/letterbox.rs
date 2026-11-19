//! Letterbox detection: finds black bars at the top and bottom of a video.
//!
//! A port of the user's letterbox.py: grab a few frames spread over the video, find the
//! rows that contain picture, skip frames that are too dark to trust, and take the
//! smallest bars over all usable frames (so the crop never cuts into the picture).

use std::process::Stdio;
use std::thread;

use serde::{Deserialize, Serialize};

use crate::ffmpeg::{command, exe};

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LetterboxOptions {
    /// How many frames to grab.
    pub samples: u32,
    /// Grab between these fractions of the duration (skip intros and credits).
    pub start_frac: f64,
    pub end_frac: f64,
    /// Gray value (0-255) up to which a pixel counts as black.
    pub black_level: u8,
    /// A row is picture if more than this fraction of its pixels is brighter than black_level.
    pub row_content_frac: f64,
    /// Frames whose picture-area mean brightness is below this are discarded.
    pub dark_frame_mean: f64,
}

impl Default for LetterboxOptions {
    fn default() -> Self {
        Self { samples: 9, start_frac: 0.10, end_frac: 0.90, black_level: 10, row_content_frac: 0.05, dark_frame_mean: 30.0 }
    }
}

const MIN_GOOD_FRAMES: usize = 3;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LetterboxResult {
    pub top: u32,
    pub bottom: u32,
    /// Frame height the bars were measured on.
    pub height: u32,
    pub usable: u32,
    pub sampled: u32,
    pub warning: Option<String>,
}

/// OpenCV's BGR2GRAY for 8-bit images (fixed point, same rounding).
#[inline]
fn gray(r: u8, g: u8, b: u8) -> u8 {
    ((r as u32 * 4899 + g as u32 * 9617 + b as u32 * 1868 + 8192) >> 14) as u8
}

/// (top, bottom) bar heights of one rgb24 frame, or None when it can't be trusted.
pub fn analyze_frame(rgb: &[u8], w: usize, h: usize, o: &LetterboxOptions) -> Option<(u32, u32)> {
    if w == 0 || h == 0 || rgb.len() < w * h * 3 {
        return None;
    }
    let row_gray = |y: usize| rgb[y * w * 3..(y + 1) * w * 3].chunks_exact(3).map(|p| gray(p[0], p[1], p[2]));
    let is_content = |y: usize| {
        let bright = row_gray(y).filter(|&v| v > o.black_level).count();
        bright as f64 / w as f64 > o.row_content_frac
    };
    let first = (0..h).find(|&y| is_content(y))?;
    let last = (0..h).rev().find(|&y| is_content(y))?;
    let top = first;
    let bottom = h - 1 - last;

    // the picture area must be a sensible part of the frame
    let pic_h = h - top - bottom;
    if (pic_h as f64) < h as f64 * 0.2 {
        return None;
    }
    // dark frames (fades, night scenes): bar edges can't be trusted
    let sum: u64 = (top..h - bottom).flat_map(row_gray).map(|v| v as u64).sum();
    let mean = sum as f64 / (pic_h * w) as f64;
    if mean < o.dark_frame_mean {
        return None;
    }
    Some((top as u32, bottom as u32))
}

/// Smallest bars over all usable frames, rounded down to even numbers.
pub fn combine(results: &[(u32, u32)]) -> Option<(u32, u32)> {
    let top = results.iter().map(|r| r.0).min()?;
    let bottom = results.iter().map(|r| r.1).min()?;
    Some((top - top % 2, bottom - bottom % 2))
}

/// Sample times in seconds, evenly spread between start_frac and end_frac.
pub fn sample_times(duration: f64, o: &LetterboxOptions) -> Vec<f64> {
    let n = o.samples.clamp(1, 100);
    (0..n)
        .map(|i| {
            let frac = o.start_frac + (o.end_frac - o.start_frac) * i as f64 / (n.max(2) - 1) as f64;
            duration * frac
        })
        .collect()
}

fn grab_frame(ff: &str, path: &str, t: f64, w: usize, h: usize) -> Result<Vec<u8>, String> {
    let out = command(ff)
        .args(["-v", "error", "-noautorotate", "-ss", &format!("{t:.3}"), "-i", path])
        .args(["-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "pipe:1"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Could not start '{ff}': {e}"))?;
    if out.stdout.len() != w * h * 3 {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "frame at {t:.1}s: got {} bytes, expected {w}×{h} ({})",
            out.stdout.len(),
            err.lines().last().unwrap_or("no error output").trim()
        ));
    }
    Ok(out.stdout)
}

pub fn detect(ff: &str, path: &str, duration: f64, w: usize, h: usize, o: &LetterboxOptions) -> Result<LetterboxResult, String> {
    if !(duration > 0.0) || w == 0 || h == 0 {
        return Err("The input has no known duration or video size (probe it first).".into());
    }
    let times = sample_times(duration, o);
    let frames: Vec<Result<Vec<u8>, String>> = thread::scope(|s| {
        let handles: Vec<_> = times.iter().map(|&t| s.spawn(move || grab_frame(ff, path, t, w, h))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("frame grab panicked".into()))).collect()
    });
    let mut errors = Vec::new();
    let mut good = Vec::new();
    for f in &frames {
        match f {
            Ok(rgb) => {
                if let Some(r) = analyze_frame(rgb, w, h, o) {
                    good.push(r);
                }
            }
            Err(e) => errors.push(e.clone()),
        }
    }
    let Some((top, bottom)) = combine(&good) else {
        return Err(match errors.first() {
            Some(e) if errors.len() == frames.len() => format!("Could not grab frames: {e}"),
            _ => "No usable (bright enough) frames found; cannot detect bars.".into(),
        });
    };
    let warning = (good.len() < MIN_GOOD_FRAMES).then(|| format!("Only {} usable frames; the result may be inaccurate.", good.len()));
    Ok(LetterboxResult { top, bottom, height: h as u32, usable: good.len() as u32, sampled: times.len() as u32, warning })
}

#[tauri::command]
pub async fn detect_letterbox(
    ffmpeg_path: Option<String>,
    path: String,
    duration: f64,
    width: u32,
    height: u32,
    options: Option<LetterboxOptions>,
) -> Result<LetterboxResult, String> {
    let ff = exe(&ffmpeg_path, "ffmpeg");
    let o = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || detect(&ff, &path, duration, width as usize, height as usize, &o))
        .await
        .map_err(|e| format!("detection failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// w×h frame: `top`/`bottom` rows of `bar` gray, picture rows of `pic` gray.
    fn frame(w: usize, h: usize, top: usize, bottom: usize, bar: u8, pic: u8) -> Vec<u8> {
        let mut v = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            let g = if y < top || y >= h - bottom { bar } else { pic };
            for _ in 0..w {
                v.extend_from_slice(&[g, g, g]);
            }
        }
        v
    }
    const O: LetterboxOptions = LetterboxOptions { samples: 9, start_frac: 0.1, end_frac: 0.9, black_level: 10, row_content_frac: 0.05, dark_frame_mean: 30.0 };

    #[test]
    fn finds_bars() {
        assert_eq!(analyze_frame(&frame(64, 400, 100, 110, 0, 128), 64, 400, &O), Some((100, 110)));
        assert_eq!(analyze_frame(&frame(64, 400, 0, 0, 0, 128), 64, 400, &O), Some((0, 0)));
    }

    #[test]
    fn near_black_noise_in_bars_counts_as_black() {
        assert_eq!(analyze_frame(&frame(64, 400, 50, 50, 8, 128), 64, 400, &O), Some((50, 50)));
        // a few bright pixels (≤ 5% of the row) don't make a row picture
        let mut f = frame(100, 400, 50, 50, 0, 128);
        for x in 0..5 {
            let i = (10 * 100 + x) * 3;
            f[i..i + 3].copy_from_slice(&[255, 255, 255]);
        }
        assert_eq!(analyze_frame(&f, 100, 400, &O), Some((50, 50)));
    }

    #[test]
    fn rejects_untrustworthy_frames() {
        assert_eq!(analyze_frame(&frame(64, 400, 0, 0, 0, 0), 64, 400, &O), None, "all black");
        assert_eq!(analyze_frame(&frame(64, 400, 100, 100, 0, 20), 64, 400, &O), None, "dark picture");
        assert_eq!(analyze_frame(&frame(64, 400, 170, 170, 0, 128), 64, 400, &O), None, "picture under 20%");
    }

    #[test]
    fn combines_to_smallest_even_bars() {
        assert_eq!(combine(&[(101, 111), (120, 109)]), Some((100, 108)));
        assert_eq!(combine(&[]), None);
    }

    #[test]
    fn matches_opencv_gray() {
        assert_eq!(gray(255, 255, 255), 255);
        assert_eq!(gray(0, 0, 0), 0);
        assert_eq!(gray(255, 0, 0), 76);
        assert_eq!(gray(0, 255, 0), 150);
    }

    #[test]
    fn spreads_samples() {
        let t = sample_times(100.0, &O);
        assert_eq!(t.len(), 9);
        assert!((t[0] - 10.0).abs() < 1e-9 && (t[8] - 90.0).abs() < 1e-9);
    }

    /// Real ffmpeg (opt-in): FFMPEG_E2E=1 cargo test
    #[test]
    fn detects_bars_in_a_real_video() {
        if std::env::var("FFMPEG_E2E").is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("ffmpegnodes-lb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let make = |name: &str, vf: &str| {
            let p = dir.join(name);
            let ok = command("ffmpeg")
                .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=10"])
                .args(["-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25"])
                .arg(&p)
                .status()
                .unwrap()
                .success();
            assert!(ok, "ffmpeg could not make {name}");
            p.to_string_lossy().into_owned()
        };
        let plain = make("bars.mkv", "pad=1280:960:0:120:black");
        let r = detect("ffmpeg", &plain, 10.0, 1280, 960, &LetterboxOptions::default()).unwrap();
        assert_eq!((r.top, r.bottom, r.usable, r.sampled), (120, 120, 9, 9));

        // black from 3 s to 7 s: those frames are skipped, the bars stay the same
        let fading = make("fade.mkv", "pad=1280:960:0:120:black,drawbox=c=black:t=fill:enable='between(t,3,7)'");
        let r = detect("ffmpeg", &fading, 10.0, 1280, 960, &LetterboxOptions::default()).unwrap();
        assert_eq!((r.top, r.bottom), (120, 120));
        assert!(r.usable < 9, "dark frames should be skipped (usable {})", r.usable);

        // uneven bars, as letterbox.py prints them: iw:ih-210:0:100
        let uneven = make("uneven.mkv", "pad=1280:930:0:100:black");
        let r = detect("ffmpeg", &uneven, 10.0, 1280, 930, &LetterboxOptions::default()).unwrap();
        assert_eq!((r.top, r.bottom), (100, 110));
        if std::env::var("FFMPEGNODES_KEEP_LB").is_err() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
