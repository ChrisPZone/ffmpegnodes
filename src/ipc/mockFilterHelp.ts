// Generated from a real ffmpeg 8 build: a few `-filters` rows and `-h filter=` texts for browser mode.
export const MOCK_FILTERS: { name: string; io: string; description: string }[] = [
  {
    "name": "vignette",
    "io": "V->V",
    "description": "Make or reverse a vignette effect."
  },
  {
    "name": "sine",
    "io": "|->A",
    "description": "Generate sine wave audio signal."
  },
  {
    "name": "showwaves",
    "io": "A->V",
    "description": "Convert input audio to a video output."
  },
  {
    "name": "xstack",
    "io": "N->V",
    "description": "Stack video inputs into custom layout."
  },
  {
    "name": "channelsplit",
    "io": "A->N",
    "description": "Split audio into per-channel streams."
  },
  {
    "name": "colorkey",
    "io": "V->V",
    "description": "Turns a certain color into transparency. Operates on RGB colors."
  },
  {
    "name": "boxblur",
    "io": "V->V",
    "description": "Blur the input."
  },
  {
    "name": "gblur",
    "io": "V->V",
    "description": "Apply Gaussian Blur filter."
  },
  {
    "name": "testsrc2",
    "io": "|->V",
    "description": "Generate another test pattern."
  },
  {
    "name": "chromakey",
    "io": "V->V",
    "description": "Turns a certain color into transparency. Operates on YUV colors."
  },
  {
    "name": "curves",
    "io": "V->V",
    "description": "Adjust components curves."
  },
  {
    "name": "vibrance",
    "io": "V->V",
    "description": "Boost or alter saturation."
  },
  {
    "name": "hue",
    "io": "V->V",
    "description": "Adjust the hue and saturation of the input video."
  },
  {
    "name": "setpts",
    "io": "V->V",
    "description": "Set PTS for the output video frame."
  },
  {
    "name": "pan",
    "io": "A->A",
    "description": "Remix channels with coefficients (panning)."
  },
  {
    "name": "acrusher",
    "io": "A->A",
    "description": "Reduce audio bit resolution."
  },
  {
    "name": "aecho",
    "io": "A->A",
    "description": "Add echoing to the audio."
  },
  {
    "name": "silenceremove",
    "io": "A->A",
    "description": "Remove silence."
  },
  {
    "name": "showspectrum",
    "io": "A->V",
    "description": "Convert input audio to a spectrum video output."
  },
  {
    "name": "lutyuv",
    "io": "V->V",
    "description": "Compute and apply a lookup table to the YUV input video."
  },
  {
    "name": "blend",
    "io": "VV->V",
    "description": "Blend two video frames into each other."
  },
  {
    "name": "tile",
    "io": "V->V",
    "description": "Tile several successive frames together."
  },
  {
    "name": "select",
    "io": "V->N",
    "description": "Select video frames to pass in output."
  },
  {
    "name": "drawbox",
    "io": "V->V",
    "description": "Draw a colored box on the input video."
  },
  {
    "name": "negate",
    "io": "V->V",
    "description": "Negate input video."
  },
  {
    "name": "edgedetect",
    "io": "V->V",
    "description": "Detect and draw edge."
  },
  {
    "name": "rotate",
    "io": "V->V",
    "description": "Rotate the input image."
  },
  {
    "name": "zoompan",
    "io": "V->V",
    "description": "Apply Zoom & Pan effect."
  },
  {
    "name": "minterpolate",
    "io": "V->V",
    "description": "Frame rate conversion using Motion Interpolation."
  },
  {
    "name": "afir",
    "io": "N->A",
    "description": "Apply Finite Impulse Response filter with supplied coefficients in additional stream(s)."
  },
  {
    "name": "asplit",
    "io": "A->N",
    "description": "Pass on the audio input to N audio outputs."
  },
  {
    "name": "split",
    "io": "V->N",
    "description": "Pass on the input to N video outputs."
  }
];

export const MOCK_FILTER_HELP: Record<string, string> = {
  "vignette": "Filter vignette\n  Make or reverse a vignette effect.\n    Inputs:\n       #0: default (video)\n    Outputs:\n       #0: default (video)\nvignette AVOptions:\n   angle             <string>     ..FV....... set lens angle (default \"PI/5\")\n   a                 <string>     ..FV....... set lens angle (default \"PI/5\")\n   x0                <string>     ..FV....... set circle center position on x-axis (default \"w/2\")\n   y0                <string>     ..FV....... set circle center position on y-axis (default \"h/2\")\n   mode              <int>        ..FV....... set forward/backward mode (from 0 to 1) (default forward)\n     forward         0            ..FV.......\n     backward        1            ..FV.......\n   eval              <int>        ..FV....... specify when to evaluate expressions (from 0 to 1) (default init)\n     init            0            ..FV....... eval expressions once during initialization\n     frame           1            ..FV....... eval expressions for each frame\n   dither            <boolean>    ..FV....... set dithering (default true)\n   aspect            <rational>   ..FV....... set aspect ratio (from 0 to DBL_MAX) (default 1/1)\n\nThis filter has support for timeline through the 'enable' option.\n",
  "sine": "Filter sine\n  Generate sine wave audio signal.\n    Inputs:\n        none (source filter)\n    Outputs:\n       #0: default (audio)\nsine AVOptions:\n   frequency         <double>     ..F.A...... set the sine frequency (from 0 to DBL_MAX) (default 440)\n   f                 <double>     ..F.A...... set the sine frequency (from 0 to DBL_MAX) (default 440)\n   beep_factor       <double>     ..F.A...... set the beep frequency factor (from 0 to DBL_MAX) (default 0)\n   b                 <double>     ..F.A...... set the beep frequency factor (from 0 to DBL_MAX) (default 0)\n   sample_rate       <int>        ..F.A...... set the sample rate (from 1 to INT_MAX) (default 44100)\n   r                 <int>        ..F.A...... set the sample rate (from 1 to INT_MAX) (default 44100)\n   duration          <duration>   ..F.A...... set the audio duration (default 0)\n   d                 <duration>   ..F.A...... set the audio duration (default 0)\n   samples_per_frame <string>     ..F.A...... set the number of samples per frame (default \"1024\")\n",
  "showwaves": "Filter showwaves\n  Convert input audio to a video output.\n    Inputs:\n       #0: default (audio)\n    Outputs:\n       #0: default (video)\nshowwaves AVOptions:\n   size              <image_size> ..FV....... set video size (default \"600x240\")\n   s                 <image_size> ..FV....... set video size (default \"600x240\")\n   mode              <int>        ..FV....... select display mode (from 0 to 3) (default point)\n     point           0            ..FV....... draw a point for each sample\n     line            1            ..FV....... draw a line for each sample\n     p2p             2            ..FV....... draw a line between samples\n     cline           3            ..FV....... draw a centered line for each sample\n   n                 <rational>   ..FV....... set how many samples to show in the same point (from 0 to INT_MAX) (default 0/1)\n   rate              <video_rate> ..FV....... set video rate (default \"25\")\n   r                 <video_rate> ..FV....... set video rate (default \"25\")\n   split_channels    <boolean>    ..FV....... draw channels separately (default false)\n   colors            <string>     ..FV....... set channels colors (default \"red|green|blue|yellow|orange|lime|pink|magenta|brown\")\n   scale             <int>        ..FV....... set amplitude scale (from 0 to 3) (default lin)\n     lin             0            ..FV....... linear\n     log             1            ..FV....... logarithmic\n     sqrt            2            ..FV....... square root\n     cbrt            3            ..FV....... cubic root\n   draw              <int>        ..FV....... set draw mode (from 0 to 1) (default scale)\n     scale           0            ..FV....... scale pixel values for each drawn sample\n     full            1            ..FV....... draw every pixel for sample directly\n",
  "xstack": "Filter xstack\n  Stack video inputs into custom layout.\n    slice threading supported\n    Inputs:\n        dynamic (depending on the options)\n    Outputs:\n       #0: default (video)\nxstack AVOptions:\n   inputs            <int>        ..FV....... set number of inputs (from 2 to INT_MAX) (default 2)\n   layout            <string>     ..FV....... set custom layout\n   grid              <image_size> ..FV....... set fixed size grid layout\n   shortest          <boolean>    ..FV....... force termination when the shortest input terminates (default false)\n   fill              <string>     ..FV....... set the color for unused pixels (default \"none\")\n",
  "channelsplit": "Filter channelsplit\n  Split audio into per-channel streams.\n    Inputs:\n       #0: default (audio)\n    Outputs:\n        dynamic (depending on the options)\nchannelsplit AVOptions:\n   channel_layout    <channel_layout> ..F.A...... Input channel layout. (default \"stereo\")\n   channels          <string>     ..F.A...... Channels to extract. (default \"all\")\n",
  "colorkey": "Filter colorkey\n  Turns a certain color into transparency. Operates on RGB colors.\n    slice threading supported\n    Inputs:\n       #0: default (video)\n    Outputs:\n       #0: default (video)\ncolorkey AVOptions:\n   color             <color>      ..FV.....T. set the colorkey key color (default \"black\")\n   similarity        <float>      ..FV.....T. set the colorkey similarity value (from 1e-05 to 1) (default 0.01)\n   blend             <float>      ..FV.....T. set the colorkey key blend value (from 0 to 1) (default 0)\n\nThis filter has support for timeline through the 'enable' option.\n"
};
