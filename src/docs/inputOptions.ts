// The ffmpeg option behind each Input node setting, for the help popups.
import type { InputOptions } from "../model/types";

export const INPUT_DOC_OPTIONS: Partial<Record<keyof InputOptions, string>> = {
  ss: "ss",
  t: "t",
  hwaccel: "hwaccel",
  hwaccel_device: "hwaccel_device",
  threads: "threads",
  r: "r",
  // image2 demuxer options (INPUT_DOC_DEMUXER)
  framerate: "framerate",
  start_number: "start_number",
  start_number_range: "start_number_range",
  pattern_type: "pattern_type",
  loop: "loop",
};

/** Input settings documented under a demuxer rather than ffmpeg's own options. */
export const INPUT_DOC_DEMUXER: Partial<Record<keyof InputOptions, string>> = {
  framerate: "image2",
  start_number: "image2",
  start_number_range: "image2",
  pattern_type: "image2",
  loop: "image2",
};
