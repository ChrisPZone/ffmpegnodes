// The ffmpeg option behind each Input node setting, for the help popups.
import type { InputOptions } from "../model/types";

export const INPUT_DOC_OPTIONS: Partial<Record<keyof InputOptions, string>> = {
  ss: "ss",
  t: "t",
  hwaccel: "hwaccel",
  hwaccel_device: "hwaccel_device",
  threads: "threads",
  r: "r",
};
