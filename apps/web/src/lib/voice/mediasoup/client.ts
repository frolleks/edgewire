import type { types } from "mediasoup-client";
import { DEBUG_VOICE } from "@/lib/env";
import type { VoicePeer, VoicePeerState } from "../types";
import { RemoteConsumers } from "./consumers";
import { createLoadedDevice } from "./device";
import { LocalProducers } from "./producers";
import { MediasoupSignaling } from "./signaling";
import { createRecvTransport, createSendTransport } from "./transports";
import type {
  JoinResponse,
  ProducerDescriptor,
  ServerPeerState,
  SignalingNotification,
  VoiceUser,
} from "./types";

type MediasoupVoiceClientOptions = {
  wsUrl: string;
  token: string;
  iceServers?: RTCIceServer[];
  onWsStateChange?: (state: "closed" | "connecting" | "open") => void;
  onIdentified?: (payload: { roomId: string; selfPeerId: string }) => void;
  onJoined?: (payload: { roomId: string; selfPeerId: string; peers: VoicePeer[] }) => void;
  onPeerJoined?: (peer: VoicePeer) => void;
  onPeerLeft?: (peerId: string) => void;
  onPeerStateUpdated?: (peerId: string, state: VoicePeerState) => void;
  onRemoteTrack?: (payload: {
    peerId: string;
    source: "mic" | "screen";
    track: MediaStreamTrack;
    stream: MediaStream;
  }) => void;
  onProducerClosed?: (payload: { producerId: string; peerId: string; source: "mic" | "screen" }) => void;
  onTransportStateChange?: (payload: { direction: "send" | "recv"; state: string }) => void;
  onError?: (message: string) => void;
  onClose?: (payload: { code: number; reason: string; expected: boolean }) => void;
};

const mapState = (state: ServerPeerState): VoicePeerState => ({
  self_mute: state.selfMute,
  self_deaf: state.selfDeaf,
  screen_sharing: state.screenSharing,
});

const mapPeer = (peerId: string, user: VoiceUser, state: ServerPeerState): VoicePeer => ({
  socketId: peerId,
  user,
  state: mapState(state),
});

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
};

export class MediasoupVoiceClient {
  private readonly signaling: MediasoupSignaling;
  private device: import("mediasoup-client").Device | null = null;
  private sendTransport: types.Transport | null = null;
  private recvTransport: types.Transport | null = null;
  private localProducers: LocalProducers | null = null;
  private remoteConsumers: RemoteConsumers | null = null;
  private expectedClose = false;
  private roomId: string | null = null;
  private selfPeerId: string | null = null;
  private pendingProducerDescriptors: ProducerDescriptor[] = [];
  private readonly consumedProducerIds = new Set<string>();
  private readonly pendingConsumes = new Map<string, Promise<void>>();

  constructor(private readonly options: MediasoupVoiceClientOptions) {
    this.signaling = new MediasoupSignaling({
      wsUrl: options.wsUrl,
      onWsStateChange: state => {
        options.onWsStateChange?.(state);
      },
      onNotification: notification => {
        void this.handleNotification(notification);
      },
      onClose: event => {
        options.onClose?.({
          code: event.code,
          reason: event.reason,
          expected: this.expectedClose,
        });
      },
    });
  }

  async connect(): Promise<void> {
    this.expectedClose = false;
    await this.signaling.connect();

    const identify = await this.signaling.request<{ peerId: string; roomId: string }>("identify", {
      token: this.options.token,
    });

    this.roomId = identify.roomId;
    this.selfPeerId = identify.peerId;
    this.options.onIdentified?.({
      roomId: identify.roomId,
      selfPeerId: identify.peerId,
    });

    const join = await this.signaling.request<JoinResponse>("join", {});

    this.roomId = join.roomId;
    this.selfPeerId = join.peerId;

    const capabilityRecord = asRecord(join.routerRtpCapabilities);
    const codecCount = Array.isArray(capabilityRecord.codecs) ? capabilityRecord.codecs.length : 0;
    const headerExtensionCount = Array.isArray(capabilityRecord.headerExtensions)
      ? capabilityRecord.headerExtensions.length
      : 0;
    this.debug("join_received", {
      roomId: join.roomId,
      peers: join.peers.length,
      producers: join.producers.length,
      codecs: codecCount,
      headerExtensions: headerExtensionCount,
    });

    this.device = await createLoadedDevice(join.routerRtpCapabilities);
    this.debug("device_loaded", {
      canProduceAudio: this.device.canProduce("audio"),
      canProduceVideo: this.device.canProduce("video"),
    });

    this.recvTransport = await createRecvTransport(this.signaling, this.device, this.options.iceServers, {
      onDebug: (event, payload) => this.debug(event, payload),
      onConnectionStateChange: (direction, state) => {
        this.options.onTransportStateChange?.({ direction, state });
      },
    });
    this.sendTransport = await createSendTransport(this.signaling, this.device, this.options.iceServers, {
      onDebug: (event, payload) => this.debug(event, payload),
      onConnectionStateChange: (direction, state) => {
        this.options.onTransportStateChange?.({ direction, state });
      },
    });
    this.localProducers = new LocalProducers();
    this.remoteConsumers = new RemoteConsumers(this.signaling, this.device, this.recvTransport, {
      onClosed: entry => {
        this.consumedProducerIds.delete(entry.producerId);
        this.options.onProducerClosed?.({
          producerId: entry.producerId,
          peerId: entry.peerId,
          source: entry.source,
        });
      },
      onDebug: (event, payload) => this.debug(event, payload),
    });

    this.options.onJoined?.({
      roomId: join.roomId,
      selfPeerId: join.peerId,
      peers: join.peers.map(peer => mapPeer(peer.peerId, peer.user, peer.state)),
    });

    for (const producer of join.producers) {
      await this.consumeProducer(producer);
    }

    if (this.pendingProducerDescriptors.length > 0) {
      for (const producer of this.pendingProducerDescriptors.splice(0)) {
        await this.consumeProducer(producer);
      }
    }
  }

  async produceMic(track: MediaStreamTrack): Promise<void> {
    if (!this.sendTransport || !this.localProducers || !this.device) {
      throw new Error("Voice send transport is not ready yet.");
    }

    if (!this.device.canProduce("audio")) {
      throw new Error("This browser cannot produce audio.");
    }

    await this.localProducers.produceMic(this.sendTransport, track);
  }

  async closeMicProducer(): Promise<void> {
    if (!this.localProducers) {
      return;
    }

    await this.localProducers.closeMic(this.signaling);
  }

  async produceScreen(track: MediaStreamTrack, displaySurface?: string): Promise<void> {
    if (!this.sendTransport || !this.localProducers || !this.device) {
      throw new Error("Voice send transport is not ready yet.");
    }

    if (!this.device.canProduce("video")) {
      throw new Error("This browser cannot produce video.");
    }

    await this.localProducers.produceScreen(this.sendTransport, track, displaySurface);
  }

  async closeScreenProducer(): Promise<void> {
    if (!this.localProducers) {
      return;
    }

    await this.localProducers.closeScreen(this.signaling);
  }

  async updatePeerState(state: VoicePeerState): Promise<void> {
    await this.signaling.request("updatePeerState", {
      selfMute: state.self_mute,
      selfDeaf: state.self_deaf,
      screenSharing: state.screen_sharing,
    });
  }

  async leave(): Promise<void> {
    this.expectedClose = true;

    try {
      await this.signaling.request("leave", {});
    } catch {
      // ignore leave errors while disconnecting
    }

    await this.cleanup();
  }

  close(): void {
    this.expectedClose = true;
    void this.cleanup();
  }

  private async cleanup(): Promise<void> {
    if (this.localProducers) {
      await this.localProducers.closeAll(this.signaling);
      this.localProducers = null;
    }

    this.remoteConsumers?.closeAll();
    this.remoteConsumers = null;

    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;

    this.device = null;
    this.pendingProducerDescriptors = [];
    this.pendingConsumes.clear();
    this.consumedProducerIds.clear();
    this.roomId = null;
    this.selfPeerId = null;

    this.signaling.close();
  }

  private async handleNotification(notification: SignalingNotification): Promise<void> {
    if (notification.method === "peerJoined") {
      const data = asRecord(notification.data);
      const peerId = typeof data.peerId === "string" ? data.peerId : null;
      const user = asRecord(data.user) as VoiceUser;
      const state = asRecord(data.state) as ServerPeerState;
      if (!peerId || !user.id) {
        return;
      }

      this.options.onPeerJoined?.(mapPeer(peerId, user, state));
      return;
    }

    if (notification.method === "peerLeft") {
      const data = asRecord(notification.data);
      const peerId = typeof data.peerId === "string" ? data.peerId : null;
      if (!peerId) {
        return;
      }

      this.remoteConsumers?.removeByPeerId(peerId);
      this.options.onPeerLeft?.(peerId);
      return;
    }

    if (notification.method === "peerStateUpdated") {
      const data = asRecord(notification.data);
      const peerId = typeof data.peerId === "string" ? data.peerId : null;
      const state = asRecord(data.state) as ServerPeerState;
      if (!peerId) {
        return;
      }

      this.options.onPeerStateUpdated?.(peerId, mapState(state));
      return;
    }

    if (notification.method === "newProducer") {
      const data = asRecord(notification.data);
      const producerId = typeof data.producerId === "string" ? data.producerId : null;
      const peerId = typeof data.peerId === "string" ? data.peerId : null;
      const kind = data.kind === "audio" || data.kind === "video" ? data.kind : null;
      if (!producerId || !peerId || !kind) {
        return;
      }

      const descriptor: ProducerDescriptor = {
        producerId,
        peerId,
        kind,
        appData: asRecord(data.appData),
      };

      if (!this.remoteConsumers) {
        this.queueProducer(descriptor);
        return;
      }

      await this.consumeProducer(descriptor);
      return;
    }

    if (notification.method === "producerClosed") {
      const data = asRecord(notification.data);
      const producerId = typeof data.producerId === "string" ? data.producerId : null;
      const peerId = typeof data.peerId === "string" ? data.peerId : null;
      if (!producerId || !peerId) {
        return;
      }

      const removed = this.remoteConsumers?.removeByProducerId(producerId);
      if (!removed) {
        this.consumedProducerIds.delete(producerId);
        this.options.onProducerClosed?.({
          producerId,
          peerId,
          source: "mic",
        });
      }
      return;
    }
  }

  private queueProducer(producer: ProducerDescriptor): void {
    const alreadyQueued = this.pendingProducerDescriptors.some(entry => entry.producerId === producer.producerId);
    if (alreadyQueued || this.consumedProducerIds.has(producer.producerId)) {
      return;
    }
    this.pendingProducerDescriptors.push(producer);
  }

  private async consumeProducer(producer: ProducerDescriptor): Promise<void> {
    if (!this.remoteConsumers) {
      this.queueProducer(producer);
      return;
    }

    if (this.consumedProducerIds.has(producer.producerId)) {
      return;
    }

    const pending = this.pendingConsumes.get(producer.producerId);
    if (pending) {
      await pending;
      return;
    }

    const consumeTask = this.consumeProducerImpl(producer);
    this.pendingConsumes.set(producer.producerId, consumeTask);

    try {
      await consumeTask;
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error.message : "Failed to consume producer.");
    } finally {
      this.pendingConsumes.delete(producer.producerId);
    }
  }

  private async consumeProducerImpl(producer: ProducerDescriptor): Promise<void> {
    if (!this.remoteConsumers) {
      this.queueProducer(producer);
      return;
    }

    this.debug("consume_start", {
      producerId: producer.producerId,
      peerId: producer.peerId,
      source: producer.appData.source,
      kind: producer.kind,
    });

    const entry = await this.remoteConsumers.consume(producer.producerId);
    const track = entry.consumer.track;
    const stream = new MediaStream([track]);

    this.options.onRemoteTrack?.({
      peerId: entry.peerId,
      source: entry.source,
      track,
      stream,
    });

    await this.remoteConsumers.resume(entry.consumer.id);
    this.debug("resume_ack", {
      consumerId: entry.consumer.id,
      producerId: entry.producerId,
      source: entry.source,
      kind: entry.kind,
    });

    this.consumedProducerIds.add(producer.producerId);
  }

  private debug(event: string, payload?: Record<string, unknown>): void {
    if (!DEBUG_VOICE) {
      return;
    }

    if (payload) {
      console.debug(`[voice] ${event}`, payload);
      return;
    }

    console.debug(`[voice] ${event}`);
  }
}
