import type { types } from "mediasoup";
import type { VoiceUser } from "../auth.js";
import type { PeerUiState } from "../rooms/peer.js";

export const requestMethods = [
  "identify",
  "join",
  "createWebRtcTransport",
  "connectWebRtcTransport",
  "produce",
  "closeProducer",
  "consume",
  "resumeConsumer",
  "leave",
  "updatePeerState",
] as const;

export type RequestMethod = (typeof requestMethods)[number];

export type ClientRequest = {
  id: string;
  method: RequestMethod;
  data?: Record<string, unknown>;
};

export type ServerResponse =
  | {
      id: string;
      ok: true;
      data: unknown;
    }
  | {
      id: string;
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export const notificationMethods = [
  "peerJoined",
  "peerLeft",
  "newProducer",
  "producerClosed",
  "peerStateUpdated",
] as const;

export type NotificationMethod = (typeof notificationMethods)[number];

export type ServerNotification = {
  notification: true;
  method: NotificationMethod;
  data: Record<string, unknown>;
};

export type PeerSummary = {
  peerId: string;
  user: VoiceUser;
  state: PeerUiState;
};

export type ProducerSummary = {
  producerId: string;
  peerId: string;
  kind: "audio" | "video";
  appData: Record<string, unknown>;
};

export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type TransportOptions = {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
  sctpParameters?: types.SctpParameters;
  iceServers?: IceServerConfig[];
  iceTransportPolicy?: "all" | "relay";
};
