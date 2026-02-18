import type { types } from "mediasoup";
import type { VoiceUser } from "../auth.js";
import { Peer, type PeerUiState } from "./peer.js";

export type RoomTransportConfig = {
  listenIp: string;
  announcedAddress?: string;
  initialAvailableOutgoingBitrate: number;
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  iceTransportPolicy?: "all" | "relay";
};

type TransportOverride = Partial<RoomTransportConfig>;

export type ProducerSummary = {
  producerId: string;
  peerId: string;
  kind: "audio" | "video";
  appData: Record<string, unknown>;
};

export class Room {
  readonly peers = new Map<string, Peer>();

  constructor(
    readonly id: string,
    readonly router: types.Router,
    private readonly transportConfig: RoomTransportConfig,
  ) {}

  createPeer(peerId: string, userId: string, user: VoiceUser): Peer {
    const existing = this.peers.get(peerId);
    if (existing) {
      return existing;
    }

    const peer = new Peer(peerId, userId, user, this.id);
    this.peers.set(peerId, peer);
    return peer;
  }

  getPeer(peerId: string): Peer | null {
    return this.peers.get(peerId) ?? null;
  }

  removePeer(peerId: string): Peer | null {
    const peer = this.peers.get(peerId) ?? null;
    if (!peer) {
      return null;
    }

    peer.close();
    this.peers.delete(peerId);
    return peer;
  }

  listPeers(): Peer[] {
    return [...this.peers.values()];
  }

  listPeerSummaries(excludePeerId?: string): Array<{ peerId: string; user: VoiceUser; state: PeerUiState }> {
    const peers: Array<{ peerId: string; user: VoiceUser; state: PeerUiState }> = [];

    for (const peer of this.peers.values()) {
      if (peer.id === excludePeerId) {
        continue;
      }

      peers.push({
        peerId: peer.id,
        user: peer.user,
        state: peer.state,
      });
    }

    return peers;
  }

  listProducerSummaries(excludePeerId?: string): ProducerSummary[] {
    const producers: ProducerSummary[] = [];

    for (const peer of this.peers.values()) {
      if (peer.id === excludePeerId) {
        continue;
      }

      for (const producer of peer.producers.values()) {
        producers.push({
          producerId: producer.id,
          peerId: peer.id,
          kind: producer.kind,
          appData: (producer.appData ?? {}) as Record<string, unknown>,
        });
      }
    }

    return producers;
  }

  findProducerOwner(producerId: string): { peer: Peer; producer: types.Producer } | null {
    for (const peer of this.peers.values()) {
      const producer = peer.producers.get(producerId);
      if (producer) {
        return {
          peer,
          producer,
        };
      }
    }

    return null;
  }

  async createWebRtcTransport(
    peer: Peer,
    direction: "send" | "recv",
    override?: TransportOverride,
  ): Promise<types.WebRtcTransport> {
    const listenIp = override?.listenIp ?? this.transportConfig.listenIp;
    const announcedAddress = override?.announcedAddress ?? this.transportConfig.announcedAddress;

    const transport = await this.router.createWebRtcTransport({
      listenIps: [
        {
          ip: listenIp,
          ...(announcedAddress ? { announcedIp: announcedAddress } : {}),
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: this.transportConfig.initialAvailableOutgoingBitrate,
      appData: {
        peerId: peer.id,
        direction,
      },
    });

    peer.setTransport(direction, transport);
    transport.observer.on("close", () => {
      peer.transports.delete(transport.id);
      if (peer.sendTransportId === transport.id) {
        peer.sendTransportId = null;
      }
      if (peer.recvTransportId === transport.id) {
        peer.recvTransportId = null;
      }
    });

    return transport;
  }

  close(): void {
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    this.router.close();
  }

  isEmpty(): boolean {
    return this.peers.size === 0;
  }

  getIceServers(): Array<{ urls: string | string[]; username?: string; credential?: string }> | undefined {
    return this.transportConfig.iceServers;
  }

  getIceTransportPolicy(): "all" | "relay" | undefined {
    return this.transportConfig.iceTransportPolicy;
  }
}
