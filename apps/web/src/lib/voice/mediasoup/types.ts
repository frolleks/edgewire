export type TransportDirection = "send" | "recv";

export type ServerPeerState = {
  selfMute: boolean;
  selfDeaf: boolean;
  screenSharing: boolean;
};

export type SignalingRequest = {
  id: string;
  method:
    | "identify"
    | "join"
    | "createWebRtcTransport"
    | "connectWebRtcTransport"
    | "produce"
    | "closeProducer"
    | "consume"
    | "resumeConsumer"
    | "leave"
    | "updatePeerState";
  data: Record<string, unknown>;
};

export type SignalingResponse =
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

export type SignalingNotification = {
  notification: true;
  method: "peerJoined" | "peerLeft" | "newProducer" | "producerClosed" | "peerStateUpdated";
  data: Record<string, unknown>;
};

export type VoiceUser = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

export type JoinedPeer = {
  peerId: string;
  userId?: string;
  displayName?: string;
  user: VoiceUser;
  state: ServerPeerState;
};

export type ProducerDescriptor = {
  producerId: string;
  peerId: string;
  kind: "audio" | "video";
  appData: Record<string, unknown>;
};

export type JoinResponse = {
  peerId: string;
  roomId: string;
  user: VoiceUser;
  routerRtpCapabilities: unknown;
  peers: JoinedPeer[];
  producers: ProducerDescriptor[];
};

export type TransportOptions = {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown[];
  dtlsParameters: unknown;
  sctpParameters?: unknown;
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
};

export type ConsumerDescriptor = {
  consumerId: string;
  producerId: string;
  peerId: string;
  kind: "audio" | "video";
  rtpParameters: unknown;
  type: string;
  appData: Record<string, unknown>;
};

export type LocalProducerSource = "mic" | "screen";

export type LocalProducerHandle = {
  producerId: string;
  source: LocalProducerSource;
};

export type RemoteConsumerHandle = {
  consumerId: string;
  producerId: string;
  peerId: string;
  source: LocalProducerSource;
  kind: "audio" | "video";
};
