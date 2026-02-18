import { routerMediaCodecs } from "../mediasoup/codecs.js";
import { WorkerPool } from "../mediasoup/worker-pool.js";
import { Room, type RoomTransportConfig } from "./room.js";

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly workerPool: WorkerPool,
    private readonly transportConfig: RoomTransportConfig,
  ) {}

  async getOrCreate(roomId: string): Promise<Room> {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }

    const worker = this.workerPool.getNextWorker();
    const router = await worker.createRouter({ mediaCodecs: routerMediaCodecs });

    const room = new Room(roomId, router, this.transportConfig);
    this.rooms.set(roomId, room);
    return room;
  }

  get(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  removeIfEmpty(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || !room.isEmpty()) {
      return;
    }

    room.close();
    this.rooms.delete(roomId);
  }

  closeAll(): void {
    for (const room of this.rooms.values()) {
      room.close();
    }

    this.rooms.clear();
  }
}
