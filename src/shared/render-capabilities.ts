export type HardwareVideoEncoder =
  | 'h264_nvenc'
  | 'h264_amf'
  | 'h264_qsv'
  | 'h264_videotoolbox'
  | 'h264_vaapi';

export type FfmpegCapability = {
  available: boolean;
  binary: string;
  h264Encoders: string[];
  hardwareEncoders: HardwareVideoEncoder[];
  verifiedHardwareEncoder?: HardwareVideoEncoder;
  error?: string;
};

export type WorkerRenderCapabilities = {
  remotion: FfmpegCapability & {
    hardwareEncodingAvailable: boolean;
  };
  hyperframes: FfmpegCapability & {
    hardwareEncodingAvailable: boolean;
  };
};
