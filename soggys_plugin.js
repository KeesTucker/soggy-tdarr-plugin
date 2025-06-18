const details = () => ({
  id: 'Tdarr_Plugin_Soggys_NVENC_HEVC_CQV_Optimised_Bitrate',
  Stage: 'Pre-processing',
  Name: 'Soggys NVENC HEVC CQ:V Optimised Bitrate',
  Type: 'Video',
  Operation: 'Transcode',
  Description: `[Contains built-in filter] MEDIAINFO HAS TO BE ENABLED IN YOUR LIBRARY.
This plugin uses NVENC and transcodes based on specified CQ:V value.
Will transcode if bitrate is greater than "optimized bitrate". Optimal bitrate accounts for fps and resolution.
Optimized bitrate can be configured using targetCodecCompression. Smaller values target lower bitrates.
FFmpeg preset can be configured, defaults to medium.
Low-res files (height ≤ lowResThreshold) will not be transcoded.
If files are not in HEVC they will be transcoded.
The output container is MKV.
You may get an "infinite transcode loop" error if CQ:V and targetCodecCompression are misaligned.
Basically: increasing targetCodecCompression allows you to lower CQ:V for higher quality and vice versa.
Thanks to JB and vdka for their plugins—this builds on their work.\n\n`,
  Version: '1.1.0',
  Tags: 'pre-processing,ffmpeg,video only,nvenc h265,configurable',
  Inputs: [
    {
      name: 'targetCodecCompression',
      type: 'number',
      defaultValue: 0.12,
      inputUI: { type: 'text' },
      tooltip: `A guessed compression ratio to compute optimal bitrate. e.g. 0.08`,
    },
    {
      name: 'cqv',
      type: 'number',
      defaultValue: 28,
      inputUI: { type: 'text' },
      tooltip: `Constant Quality value for NVENC (lower = higher quality). e.g. 28`,
    },
    {
      name: 'bframe',
      type: 'number',
      defaultValue: 0,
      inputUI: { type: 'text' },
      tooltip: `Number of B-frames (0–5). Set 0 to disable.`,
    },
    {
      name: 'ten_bit',
      type: 'boolean',
      defaultValue: true,
      inputUI: {
        type: 'dropdown',
        options: ['true', 'false'],
      },
      tooltip: `Enable 10-bit output (p010le) if supported.`,
    },
    {
      name: 'ffmpeg_preset',
      type: 'string',
      defaultValue: 'medium',
      inputUI: { type: 'text' },
      tooltip: `FFmpeg preset for encoding (veryfast, fast, medium, slow, etc.).`,
    },
    {
      name: 'lowResThreshold',
      type: 'number',
      defaultValue: 720,
      inputUI: { type: 'text' },
      tooltip: `Skip HEVC files with height ≤ this value.`,
    },
    {
      name: 'minCompressionGain',
      type: 'number',
      defaultValue: 0.10,
      inputUI: { type: 'text' },
      tooltip: `Minimum proportional bitrate reduction (e.g. 0.1 = 10%) to trigger transcode.`,
    },
  ],
});

const plugin = (file, librarySettings, inputs) => {
  const lib = require('../methods/lib')();
  inputs = lib.loadDefaultValues(inputs, details);

    const response = {
    processFile: false,
    preset: '',
    container: '.mkv',
    handBrakeMode: false,
    FFmpegMode: false,
    reQueueAfter: true,
    infoLog: '',
  };

  // 1) Skip non-video
  if (file.fileMedium !== 'video') {
    response.infoLog += '✘ Not a video\n';
    return response;
  }
  response.infoLog += '✔ Video detected\n';

  // 2) Extract stream info
  const { streams } = file.ffProbeData;
  const video = streams.find(s => s.codec_type === 'video');
  const { width, height, bit_rate: vbRaw, codec_name: codec } = video;
  const fps = Number(file.mediaInfo.track?.[0]?.FrameRate) || 30;
  const streamBR = Number.isFinite(+vbRaw) ? +vbRaw : file.bit_rate;

  response.infoLog += `Stream: ${width}x${height}@${fps}fps\n`;
  response.infoLog += `Bitrate: ${(streamBR / 1e6).toFixed(2)} Mbps\n`;

  // 3) Optimal bitrate calculation
  const optimalBR = calculateOptimalBitrate(width, height, fps, inputs.targetCodecCompression);
  response.infoLog += `Optimal Bitrate: ${(optimalBR / 1e6).toFixed(2)} Mbps\n`;

  // 4) Skip low-res or insufficient gain for HEVC
  if (codec === 'hevc') {
    if (height <= inputs.lowResThreshold) {
      response.infoLog += `✔ HEVC & height ≤ ${inputs.lowResThreshold}px — skipping\n`;
      return response;
    }
    const gain = (streamBR - optimalBR) / streamBR;
    response.infoLog += `Expected Gain: ${(gain * 100).toFixed(1)}%\n`;
    if (gain < inputs.minCompressionGain) {
      response.infoLog += `✔ Gain < ${inputs.minCompressionGain * 100}% — skipping\n`;
      return response;
    }
  }

  // 5) Build ffmpeg sections (legacy single-string style)
  let mapFlag = '-map 0';
  let subcli  = '-c:s copy';
  let maxmux  = '';

  file.ffProbeData.streams.forEach(s => {
    // skip any stream without a codec_name
    if (!s.codec_name) return;

    const name = s.codec_name.toLowerCase();
    const type = s.codec_type?.toLowerCase() || '';

    if (type === 'subtitle' && name === 'mov_text')      subcli = '-c:s srt';
    if (['truehd','dts'].includes(name))                  maxmux = '-max_muxing_queue_size 9999';
    if (type === 'video' && ['png','bmp','mjpeg'].includes(name)) {
        mapFlag = '-map 0:v:0 -map 0:a -map 0:s?';
    }
  });

  // Tdarr will replace <io> with "-i <input> <outputOptions>"
  response.preset = [
    '-hwaccel cuda',
    '-dn',
    '<io>',
    mapFlag,
    '-c:v hevc_nvenc',
    `-preset ${inputs.ffmpeg_preset || 'medium'}`,
    `-cq ${inputs.cqv}`,
    '-b:v 0',                 // ← now right after CQ
    '-rc-lookahead 32',
    `-bf ${inputs.bframe}`,
    '-a53cc 0',
    inputs.ten_bit ? '-pix_fmt p010le' : null,
    '-c:a copy',
    subcli,
    maxmux
  ].filter(Boolean).join(' ');

  response.processFile = true;
  response.FFmpegMode  = true;
  response.infoLog    += '✔ Transcoding with NVENC HEVC\n';


  return response;

};

function calculateOptimalBitrate(width, height, fps, compression) {
  return Math.floor(width * height * fps * compression);
}

module.exports.details = details;
module.exports.plugin = plugin;
