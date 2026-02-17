import type { UserSummary } from "@discord/types";

export type VoiceJoinPhase =
  | "idle"
  | "requesting_token"
  | "connecting_ws"
  | "authenticating"
  | "joining_room"
  | "acquiring_microphone"
  | "negotiating_peers"
  | "connected"
  | "reconnecting"
  | "failed"
  | "leaving";

export type PeerLinkState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type VoiceConnectionStatus = {
  phase: VoiceJoinPhase;
  startedAt: number;
  lastTransitionAt: number;
  error?: { code: string; message: string; detail?: string };
  ws: { state: "closed" | "connecting" | "open"; rttMs?: number; lastPongAt?: number };
  media: { mic: "unknown" | "prompting" | "granted" | "denied" | "ready"; hasLocalAudioTrack: boolean };
  peers: {
    total: number;
    connected: number;
    connecting: number;
    failed: number;
    bySocketId: Record<string, { state: PeerLinkState; ice: string; lastChangeAt: number }>;
  };
};

export type VoicePeerState = {
  self_mute: boolean;
  self_deaf: boolean;
  screen_sharing: boolean;
};

export type VoicePeer = {
  socketId: string;
  user: UserSummary;
  state: VoicePeerState;
};

export type VoiceSignalEnvelope = {
  from: string;
  to?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  screen?: boolean;
};

export type VoiceServerMessage = {
  op:
    | "VOICE_STATE"
    | "READY"
    | "PEER_JOINED"
    | "PEER_LEFT"
    | "SIGNAL_OFFER"
    | "SIGNAL_ANSWER"
    | "SIGNAL_ICE"
    | "PEER_STATE_UPDATE"
    | "PING"
    | "PONG"
    | "ERROR";
  d: Record<string, unknown>;
};
