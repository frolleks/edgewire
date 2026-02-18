import type { types } from "mediasoup-client";
import type { MediasoupSignaling } from "./signaling";

export class LocalProducers {
  mic: types.Producer | null = null;
  screen: types.Producer | null = null;

  async produceMic(sendTransport: types.Transport, track: MediaStreamTrack): Promise<types.Producer> {
    if (this.mic) {
      await this.mic.close();
      this.mic = null;
    }

    const producer = await sendTransport.produce({
      track,
      appData: {
        source: "mic",
      },
    });

    producer.on("transportclose", () => {
      this.mic = null;
    });

    this.mic = producer;
    return producer;
  }

  async produceScreen(
    sendTransport: types.Transport,
    track: MediaStreamTrack,
    displaySurface?: string,
  ): Promise<types.Producer> {
    if (this.screen) {
      await this.screen.close();
      this.screen = null;
    }

    const producer = await sendTransport.produce({
      track,
      appData: {
        source: "screen",
        ...(displaySurface ? { displaySurface } : {}),
      },
    });

    producer.on("transportclose", () => {
      this.screen = null;
    });

    this.screen = producer;
    return producer;
  }

  async closeMic(signaling: MediasoupSignaling): Promise<void> {
    if (!this.mic) {
      return;
    }

    const producerId = this.mic.id;
    this.mic.close();
    this.mic = null;
    await signaling.request("closeProducer", { producerId }).catch(() => undefined);
  }

  async closeScreen(signaling: MediasoupSignaling): Promise<void> {
    if (!this.screen) {
      return;
    }

    const producerId = this.screen.id;
    this.screen.close();
    this.screen = null;
    await signaling.request("closeProducer", { producerId }).catch(() => undefined);
  }

  async closeAll(signaling: MediasoupSignaling): Promise<void> {
    await this.closeScreen(signaling);
    await this.closeMic(signaling);
  }
}
