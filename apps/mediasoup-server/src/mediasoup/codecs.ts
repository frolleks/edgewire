import type { types } from "mediasoup";

export const routerMediaCodecs: types.RtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48_000,
    preferredPayloadType: 111,
    channels: 2,
    parameters: {
      useinbandfec: 1,
      minptime: 10,
    },
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90_000,
    preferredPayloadType: 96,
    parameters: {
      "x-google-start-bitrate": 1_000,
    },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90_000,
    preferredPayloadType: 102,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
    },
  },
];
