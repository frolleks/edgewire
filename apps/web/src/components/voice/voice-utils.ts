import type { VoiceConnectionStatus, VoiceJoinPhase } from "@/lib/voice/types";

export const voicePhaseLabel = (phase: VoiceJoinPhase): string => {
  switch (phase) {
    case "requesting_token":
      return "Starting voice";
    case "connecting_ws":
      return "Connecting to voice server";
    case "authenticating":
      return "Authenticating";
    case "joining_room":
      return "Joining channel";
    case "acquiring_microphone":
      return "Setting up microphone";
    case "negotiating_peers":
      return "Negotiating peers";
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    case "failed":
      return "Connection failed";
    case "leaving":
      return "Leaving voice";
    default:
      return "Idle";
  }
};

export const voiceStatusDetail = (status: VoiceConnectionStatus): string => {
  const rtt = typeof status.ws.rttMs === "number" ? ` ${status.ws.rttMs}ms` : "";
  return `ws ${status.ws.state}${rtt} • mic ${status.media.mic} • peers ${status.peers.connected}/${status.peers.total}`;
};
