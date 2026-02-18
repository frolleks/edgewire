import type { Device, types } from "mediasoup-client";
import type { MediasoupSignaling } from "./signaling";
import type { ConsumerDescriptor, LocalProducerSource } from "./types";

export type RemoteConsumerEntry = {
  consumer: types.Consumer;
  producerId: string;
  peerId: string;
  source: LocalProducerSource;
  kind: "audio" | "video";
};

type ConsumerDebugEvent = "consume_start" | "consume_done" | "consume_error";

type RemoteConsumerCallbacks = {
  onClosed?: (entry: RemoteConsumerEntry) => void;
  onDebug?: (event: ConsumerDebugEvent, payload: Record<string, unknown>) => void;
};

const sourceFrom = (descriptor: ConsumerDescriptor): LocalProducerSource => {
  const source = descriptor.appData?.source;
  if (source === "screen") {
    return "screen";
  }
  return "mic";
};

export class RemoteConsumers {
  private readonly byConsumerId = new Map<string, RemoteConsumerEntry>();
  private readonly byProducerId = new Map<string, RemoteConsumerEntry>();
  private readonly pendingByProducerId = new Map<string, Promise<RemoteConsumerEntry>>();

  constructor(
    private readonly signaling: MediasoupSignaling,
    private readonly device: Device,
    private readonly recvTransport: types.Transport,
    private readonly callbacks?: RemoteConsumerCallbacks,
  ) {}

  async consume(producerId: string): Promise<RemoteConsumerEntry> {
    const existing = this.byProducerId.get(producerId);
    if (existing) {
      return existing;
    }

    const pending = this.pendingByProducerId.get(producerId);
    if (pending) {
      return await pending;
    }

    const request = this.consumeImpl(producerId);
    this.pendingByProducerId.set(producerId, request);
    try {
      return await request;
    } catch (error) {
      this.callbacks?.onDebug?.("consume_error", {
        producerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.pendingByProducerId.delete(producerId);
    }
  }

  async resume(consumerId: string): Promise<void> {
    await this.signaling.request("resumeConsumer", {
      consumerId,
    });
  }

  removeByProducerId(producerId: string): RemoteConsumerEntry | null {
    const entry = this.byProducerId.get(producerId) ?? null;
    if (!entry) {
      return null;
    }

    this.removeConsumer(entry.consumer.id);
    return entry;
  }

  removeByPeerId(peerId: string): RemoteConsumerEntry[] {
    const removed: RemoteConsumerEntry[] = [];

    for (const entry of [...this.byConsumerId.values()]) {
      if (entry.peerId !== peerId) {
        continue;
      }

      this.removeConsumer(entry.consumer.id);
      removed.push(entry);
    }

    return removed;
  }

  closeAll(): void {
    for (const entry of [...this.byConsumerId.values()]) {
      this.removeConsumer(entry.consumer.id);
    }
  }

  private async consumeImpl(producerId: string): Promise<RemoteConsumerEntry> {
    this.callbacks?.onDebug?.("consume_start", {
      producerId,
      transportId: this.recvTransport.id,
    });

    const recvRtpCapabilities = this.getRecvRtpCapabilities();
    const descriptor = await this.signaling.request<ConsumerDescriptor>("consume", {
      transportId: this.recvTransport.id,
      producerId,
      rtpCapabilities: recvRtpCapabilities,
    });

    const consumer = await this.recvTransport.consume({
      id: descriptor.consumerId,
      producerId: descriptor.producerId,
      kind: descriptor.kind,
      rtpParameters: descriptor.rtpParameters as types.RtpParameters,
      appData: descriptor.appData,
    });

    const entry: RemoteConsumerEntry = {
      consumer,
      producerId: descriptor.producerId,
      peerId: descriptor.peerId,
      source: sourceFrom(descriptor),
      kind: descriptor.kind,
    };

    this.byConsumerId.set(consumer.id, entry);
    this.byProducerId.set(descriptor.producerId, entry);

    consumer.on("transportclose", () => {
      this.removeConsumer(consumer.id);
    });

    consumer.on("trackended", () => {
      this.removeConsumer(consumer.id);
    });

    this.callbacks?.onDebug?.("consume_done", {
      producerId: descriptor.producerId,
      consumerId: descriptor.consumerId,
      peerId: descriptor.peerId,
      kind: descriptor.kind,
      source: entry.source,
    });

    return entry;
  }

  private getRecvRtpCapabilities(): types.RtpCapabilities {
    const withCapabilities = this.device as Device & {
      recvRtpCapabilities?: types.RtpCapabilities;
      rtpCapabilities?: types.RtpCapabilities;
    };

    const recvCaps = withCapabilities.recvRtpCapabilities ?? withCapabilities.rtpCapabilities;
    if (!recvCaps) {
      throw new Error("mediasoup device missing recv RTP capabilities.");
    }

    return recvCaps;
  }

  private removeConsumer(consumerId: string): void {
    const entry = this.byConsumerId.get(consumerId);
    if (!entry) {
      return;
    }

    if (!entry.consumer.closed) {
      entry.consumer.close();
    }
    this.byConsumerId.delete(consumerId);
    this.byProducerId.delete(entry.producerId);
    this.callbacks?.onClosed?.(entry);
  }
}
