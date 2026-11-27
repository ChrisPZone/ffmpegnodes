//! Thin process layer around the ffmpeg / ffprobe executables.
//!
//! Everything is spawned with an argument vector (never through a shell), so the
//! frontend's serializer is the only place that decides what ffmpeg receives.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::Jobs;

pub struct JobHandle {
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
}

/// Resolve the executable: explicit path from settings, else rely on PATH.
pub(crate) fn exe(explicit: &Option<String>, default_name: &str) -> String {
    match explicit {
        Some(p) if !p.trim().is_empty() => p.trim().to_string(),
        _ => default_name.to_string(),
    }
}

pub(crate) fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn run_capture(program: &str, args: &[&str]) -> Result<String, String> {
    let out = command(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            format!("Could not start '{program}': {e}. Install ffmpeg or set its path in Settings.")
        })?;
    if !out.status.success() {
        return Err(format!(
            "'{program} {}' failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Serialize)]
pub struct EncoderInfo {
    name: String,
    media: String,
    /// libavcodec codec id the encoder produces (hevc for libx265 / hevc_nvenc).
    codec: String,
    description: String,
}

#[derive(Serialize)]
pub struct MuxerInfo {
    name: String,
    description: String,
}

#[derive(Serialize)]
pub struct FilterInfo {
    name: String,
    io: String,
    description: String,
}

#[derive(Serialize)]
pub struct Capabilities {
    version: String,
    encoders: Vec<EncoderInfo>,
    muxers: Vec<MuxerInfo>,
    filters: Vec<FilterInfo>,
}

/// Rows after the dashed separator line, split into (flags, name, description).
fn listing(text: &str) -> Vec<(String, String, String)> {
    let mut started = false;
    let mut rows = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if !started {
            if t.len() >= 2 && t.chars().all(|c| c == '-') {
                started = true;
            }
            continue;
        }
        let mut parts = line.trim_start().splitn(2, char::is_whitespace);
        let flags = parts.next().unwrap_or("").to_string();
        let rest = parts.next().unwrap_or("").trim_start();
        let mut parts = rest.splitn(2, char::is_whitespace);
        let name = parts.next().unwrap_or("").to_string();
        let desc = parts.next().unwrap_or("").trim().to_string();
        if !name.is_empty() {
            rows.push((flags, name, desc));
        }
    }
    rows
}

fn parse_encoders(text: &str) -> Vec<EncoderInfo> {
    listing(text)
        .into_iter()
        .filter_map(|(flags, name, description)| {
            let media = match flags.chars().next()? {
                'V' => "video",
                'A' => "audio",
                'S' => "subtitle",
                _ => return None,
            };
            // Without "(codec x)" the encoder name is the codec name (e.g. "aac").
            let codec = codec_id_from_description(&description).unwrap_or_else(|| name.clone());
            Some(EncoderInfo { name, media: media.into(), codec, description })
        })
        .collect()
}

fn parse_muxers(text: &str) -> Vec<MuxerInfo> {
    listing(text)
        .into_iter()
        .filter(|(flags, _, _)| flags.contains('E'))
        .map(|(_, name, description)| MuxerInfo { name, description })
        .collect()
}

fn parse_filters(text: &str) -> Vec<FilterInfo> {
    // Rows after the dashes look like " TS scale   V->V   Scale the input video ..."
    // (the flag column is 2 or 3 characters depending on the ffmpeg version).
    listing(text)
        .into_iter()
        .filter_map(|(_, name, rest)| {
            let mut parts = rest.splitn(2, char::is_whitespace);
            let io = parts.next()?.to_string();
            if !io.contains("->") {
                return None;
            }
            let description = parts.next().unwrap_or("").trim().to_string();
            Some(FilterInfo { name, io, description })
        })
        .collect()
}

/// "libx265 H.265 / HEVC (codec hevc)" → Some("hevc")
fn codec_id_from_description(desc: &str) -> Option<String> {
    let start = desc.rfind("(codec ")? + "(codec ".len();
    let end = desc[start..].find(')')? + start;
    Some(desc[start..end].trim().to_string())
}

#[tauri::command]
pub async fn get_capabilities(ffmpeg_path: Option<String>) -> Result<Capabilities, String> {
    let ff = exe(&ffmpeg_path, "ffmpeg");
    let version = run_capture(&ff, &["-hide_banner", "-version"])?
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    let encoders = parse_encoders(&run_capture(&ff, &["-hide_banner", "-encoders"])?);
    let muxers = parse_muxers(&run_capture(&ff, &["-hide_banner", "-muxers"])?);
    let filters = parse_filters(&run_capture(&ff, &["-hide_banner", "-filters"])?);
    Ok(Capabilities { version, encoders, muxers, filters })
}

/// Filter names are plain identifiers; anything else is refused before spawning ffmpeg.
fn valid_filter_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Raw `ffmpeg -h filter=<name>` text (pads and AVOptions); the frontend parses it.
#[tauri::command]
pub async fn filter_help(ffmpeg_path: Option<String>, name: String) -> Result<String, String> {
    if !valid_filter_name(&name) {
        return Err(format!("'{name}' is not a valid filter name"));
    }
    let ff = exe(&ffmpeg_path, "ffmpeg");
    let text = run_capture(&ff, &["-hide_banner", "-h", &format!("filter={name}")])?;
    // ffmpeg exits 0 for unknown filters too
    if text.trim_start().starts_with("Unknown filter") {
        return Err(format!("This ffmpeg has no filter named '{name}'"));
    }
    Ok(text)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GpuInfo {
    index: u32,
    name: String,
}

/// Parses nvenc's `-gpu list` log lines: "[ GPU #0 - < NVIDIA GeForce RTX 4090 > has Compute SM 8.9 ]".
fn parse_gpu_list(text: &str) -> Vec<GpuInfo> {
    text.lines()
        .filter_map(|line| {
            let rest = &line[line.find("GPU #")? + "GPU #".len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            let index = digits.parse().ok()?;
            let open = rest.find("< ")? + 2;
            let close = rest[open..].find(" >")? + open;
            Some(GpuInfo { index, name: rest[open..close].trim().to_string() })
        })
        .collect()
}

/// NVIDIA GPUs in CUDA order (the numbering -hwaccel_device and -gpu use), via an nvenc encoder.
#[tauri::command]
pub async fn list_gpus(ffmpeg_path: Option<String>, encoder: String) -> Result<Vec<GpuInfo>, String> {
    if !encoder.ends_with("_nvenc") {
        return Err(format!("'{encoder}' is not an nvenc encoder"));
    }
    let ff = exe(&ffmpeg_path, "ffmpeg");
    // This always exits with an error after printing the list, so read stderr regardless.
    let out = command(&ff)
        .args([
            "-hide_banner", "-f", "lavfi", "-i", "nullsrc=s=256x256", "-frames:v", "1",
            "-c:v", &encoder, "-gpu", "list", "-f", "null", "-",
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Could not start '{ff}': {e}"))?;
    let log = String::from_utf8_lossy(&out.stderr);
    let gpus = parse_gpu_list(&log);
    if gpus.is_empty() {
        let last = log.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no output");
        return Err(format!("No NVIDIA GPU found ({})", last.trim()));
    }
    Ok(gpus)
}

#[tauri::command]
pub async fn probe_file(
    path: String,
    input_args: Option<Vec<String>>,
    ffprobe_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let fp = exe(&ffprobe_path, "ffprobe");
    let out = run_capture(&fp, &probe_args(&path, &input_args.unwrap_or_default()))?;
    serde_json::from_str(&out).map_err(|e| format!("Unreadable ffprobe output: {e}"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    job_id: String,
    /// One block from `-progress pipe:1` (out_time_us, speed, fps, progress, ...).
    values: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    job_id: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    job_id: String,
    code: Option<i32>,
    success: bool,
}

#[tauri::command]
pub fn run_job(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    job_id: String,
    args: Vec<String>,
    ffmpeg_path: Option<String>,
) -> Result<(), String> {
    let ff = exe(&ffmpeg_path, "ffmpeg");
    let mut child = command(&ff)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start '{ff}': {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take();
    let child = Arc::new(Mutex::new(child));

    jobs.0
        .lock()
        .map_err(|_| "job table poisoned")?
        .insert(job_id.clone(), JobHandle { child: child.clone(), stdin });

    // -progress emits blocks of key=value lines terminated by "progress=continue|end".
    {
        let app = app.clone();
        let job_id = job_id.clone();
        thread::spawn(move || {
            let mut values = HashMap::new();
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some((k, v)) = line.split_once('=') {
                    let k = k.trim().to_string();
                    let end = k == "progress";
                    values.insert(k, v.trim().to_string());
                    if end {
                        let _ = app.emit(
                            "job:progress",
                            ProgressEvent { job_id: job_id.clone(), values: std::mem::take(&mut values) },
                        );
                    }
                }
            }
        });
    }
    {
        let app = app.clone();
        let job_id = job_id.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = app.emit("job:log", LogEvent { job_id: job_id.clone(), line });
            }
        });
    }
    // Poll instead of blocking in wait() so cancel_job can still lock the child to kill it.
    thread::spawn(move || loop {
        let status = child.lock().ok().and_then(|mut c| c.try_wait().ok()).flatten();
        if let Some(status) = status {
            if let Some(state) = app.try_state::<Jobs>() {
                if let Ok(mut map) = state.0.lock() {
                    map.remove(&job_id);
                }
            }
            let _ = app.emit(
                "job:done",
                DoneEvent { job_id: job_id.clone(), code: status.code(), success: status.success() },
            );
            break;
        }
        thread::sleep(Duration::from_millis(100));
    });
    Ok(())
}

/// Ask ffmpeg to stop gracefully ("q" on stdin finalizes the file); kill after 3 s.
#[tauri::command]
pub fn cancel_job(jobs: State<'_, Jobs>, job_id: String) -> Result<(), String> {
    let (child, stdin) = {
        let mut map = jobs.0.lock().map_err(|_| "job table poisoned")?;
        match map.get_mut(&job_id) {
            Some(h) => (h.child.clone(), h.stdin.take()),
            None => return Ok(()),
        }
    };
    if let Some(mut stdin) = stdin {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let done = child.lock().ok().and_then(|mut c| c.try_wait().ok()).flatten().is_some();
            if done {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if let Ok(mut c) = child.lock() {
            let _ = c.kill();
        }
    });
    Ok(())
}

/// ffprobe arguments: the input's demuxer options (e.g. `-framerate`, `-start_number`) go
/// before the file, as they do on the ffmpeg command line.
fn probe_args<'a>(path: &'a str, input_args: &'a [String]) -> Vec<&'a str> {
    let mut a = vec!["-v", "error"];
    a.extend(input_args.iter().map(String::as_str));
    a.extend(["-show_streams", "-show_format", "-of", "json", path]);
    a
}

/// Names of the files (not folders) in a folder, sorted. Used to find image sequences.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<String>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| format!("Could not list {path}: {e}"))?;
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Could not write {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_args_put_input_options_before_the_file() {
        let opts = vec!["-framerate".to_string(), "60".to_string(), "-start_number".to_string(), "1001".to_string()];
        assert_eq!(
            probe_args("shot_%04d.png", &opts),
            vec!["-v", "error", "-framerate", "60", "-start_number", "1001", "-show_streams", "-show_format", "-of", "json", "shot_%04d.png"]
        );
    }

    #[test]
    fn lists_files_only() {
        let dir = std::env::temp_dir().join(format!("ffmpegnodes-listdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        for n in ["b_0002.png", "b_0001.png"] {
            std::fs::write(dir.join(n), b"x").unwrap();
        }
        let names = list_dir(dir.to_string_lossy().into_owned()).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(names, vec!["b_0001.png", "b_0002.png"]);
        assert!(list_dir(dir.to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn validates_filter_names() {
        assert!(valid_filter_name("scale_cuda"));
        assert!(!valid_filter_name("scale=w=1"));
        assert!(!valid_filter_name("a b"));
        assert!(!valid_filter_name(""));
    }

    #[test]
    fn parses_gpu_list() {
        let text = "[h264_nvenc @ 000001] [ GPU #0 - < NVIDIA GeForce RTX 4090 > has Compute SM 8.9 ]\n[h264_nvenc @ 000001] [ GPU #1 - < NVIDIA RTX A2000 12GB > has Compute SM 8.6 ]\n[vost#0:0/h264_nvenc @ 0002] Error while opening encoder\n";
        assert_eq!(
            parse_gpu_list(text),
            vec![
                GpuInfo { index: 0, name: "NVIDIA GeForce RTX 4090".into() },
                GpuInfo { index: 1, name: "NVIDIA RTX A2000 12GB".into() },
            ]
        );
    }

    #[test]
    fn parses_encoder_listing() {
        let text = "Encoders:\n V..... = Video\n ------\n V....D libx265              libx265 H.265 / HEVC (codec hevc)\n A....D aac                  AAC (Advanced Audio Coding)\n S..... mov_text             3GPP Timed Text subtitle\n";
        let enc = parse_encoders(text);
        assert_eq!(enc.len(), 3);
        assert_eq!(enc[0].name, "libx265");
        assert_eq!(enc[0].codec, "hevc");
        assert_eq!(enc[1].media, "audio");
        assert_eq!(enc[1].codec, "aac");
        assert_eq!(enc[2].media, "subtitle");
    }

    #[test]
    fn parses_muxer_listing() {
        // Format of ffmpeg 7+/8 (3-column flags, "---" separator).
        let text = "Formats:\n D.. = Demuxing supported\n .E. = Muxing supported\n ---\n  E  3g2             3GP2 (3GPP2 file format)\n DE  matroska        Matroska\n D   aa              Audible AA\n";
        let mux = parse_muxers(text);
        let names: Vec<_> = mux.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["3g2", "matroska"]);
    }

    #[test]
    fn parses_filter_listing() {
        // Real ffmpeg 8 output: legend, dashes, then 2-character flags.
        let text = "Filters:\n  T.. = Timeline support\n  A = Audio input/output\n  | = Source or sink filter\n  ------\n TS scale             V->V       Scale the input video size.\n .. amix              N->A       Audio mixing.\n";
        let f = parse_filters(text);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].name, "scale");
        assert_eq!(f[1].io, "N->A");
        assert_eq!(f[1].description, "Audio mixing.");
    }
}
