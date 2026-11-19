// ffmpeg's filtergraph escaping has two levels (see "Notes on filtergraph escaping" in ffmpeg-filters):
//   1. an option value inside a filter's argument list: escape \ ' :
//   2. the filter description inside the filtergraph:   escape \ ' [ ] , ;
// Shell quoting is a third level, but we pass argv directly so it only matters for the preview.

export function escapeOptionValue(v: string): string {
  return v.replace(/[\\':]/g, "\\$&");
}

export function escapeFilterGraph(s: string): string {
  return s.replace(/[\\'[\],;]/g, "\\$&");
}
