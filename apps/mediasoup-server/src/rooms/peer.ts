import type { types } from "mediasoup";
import type { VoiceUser } from "../auth.js";

export type PeerUiState = {
  selfMute: boolean;
  selfDeaf: boolean;
  screenSharing: boolean;
};

export class Peer {
  readonly transports = new Map<string, types.WebRtcTransport>();
  readonly producers = new Map<string, types.Producer>();
  readonly consumers = new Map<string, types.Consumer>();
  readonly consumerProducerIds = new Map<string, string>();
  readonly consumerIdsByProducerId = new Map<string, string>();

  sendTransportId: string | null = null;
  recvTransportId: string | null = null;
  state: PeerUiState = {
    selfMute: false,
    selfDeaf: false,
    screenSharing: false,
  };

  constructor(
    readonly id: string,
    readonly userId: string,
    readonly user: VoiceUser,
    readonly roomId: string,
  ) {}

  setTransport(direction: "send" | "recv", transport: types.WebRtcTransport): void {
    this.transports.set(transport.id, transport);

    if (direction === "send") {
      this.sendTransportId = transport.id;
      return;
    }

    this.recvTransportId = transport.id;
  }

  getTransport(transportId: string): types.WebRtcTransport | null {
    return this.transports.get(transportId) ?? null;
  }

  getSendTransport(): types.WebRtcTransport | null {
    if (!this.sendTransportId) {
      return null;
    }

    return this.transports.get(this.sendTransportId) ?? null;
  }

  getRecvTransport(): types.WebRtcTransport | null {
    if (!this.recvTransportId) {
      return null;
    }

    return this.transports.get(this.recvTransportId) ?? null;
  }

  addProducer(producer: types.Producer): void {
    this.producers.set(producer.id, producer);
  }

  removeProducer(producerId: string): types.Producer | null {
    const producer = this.producers.get(producerId) ?? null;
    if (!producer) {
      return null;
    }

    this.producers.delete(producerId);
    return producer;
  }

  addConsumer(consumer: types.Consumer, producerId: string): void {
    this.consumers.set(consumer.id, consumer);
    this.consumerProducerIds.set(consumer.id, producerId);
    this.consumerIdsByProducerId.set(producerId, consumer.id);
  }

  getConsumer(consumerId: string): types.Consumer | null {
    return this.consumers.get(consumerId) ?? null;
  }

  getConsumerByProducerId(producerId: string): types.Consumer | null {
    const consumerId = this.consumerIdsByProducerId.get(producerId);
    if (!consumerId) {
      return null;
    }

    return this.consumers.get(consumerId) ?? null;
  }

  closeConsumer(consumerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) {
      return;
    }

    consumer.close();
    this.consumers.delete(consumerId);
    const producerId = this.consumerProducerIds.get(consumerId);
    this.consumerProducerIds.delete(consumerId);
    if (producerId) {
      this.consumerIdsByProducerId.delete(producerId);
    }
  }

  close(): void {
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
    this.consumers.clear();
    this.consumerProducerIds.clear();
    this.consumerIdsByProducerId.clear();

    for (const producer of this.producers.values()) {
      producer.close();
    }
    this.producers.clear();

    for (const transport of this.transports.values()) {
      transport.close();
    }
    this.transports.clear();

    this.sendTransportId = null;
    this.recvTransportId = null;
  }
}
