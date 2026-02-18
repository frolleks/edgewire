import * as mediasoup from "mediasoup";
import type { types } from "mediasoup";

type WorkerPoolOptions = {
  workerCount: number;
  rtcMinPort: number;
  rtcMaxPort: number;
};

export class WorkerPool {
  private readonly workers: types.Worker[] = [];
  private nextWorkerIndex = 0;
  private closed = false;

  constructor(private readonly options: WorkerPoolOptions) {}

  async init(): Promise<void> {
    for (let index = 0; index < this.options.workerCount; index += 1) {
      const worker = await this.createWorker(index);
      this.workers.push(worker);
    }
  }

  getNextWorker(): types.Worker {
    if (this.workers.length === 0) {
      throw new Error("Mediasoup worker pool is not initialized.");
    }

    const worker = this.workers[this.nextWorkerIndex % this.workers.length];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const worker of this.workers) {
      await worker.close();
    }
    this.workers.length = 0;
  }

  private async createWorker(index: number): Promise<types.Worker> {
    const worker = await mediasoup.createWorker({
      logLevel: "warn",
      rtcMinPort: this.options.rtcMinPort,
      rtcMaxPort: this.options.rtcMaxPort,
    });

    worker.on("died", () => {
      console.error(`Mediasoup worker ${worker.pid} died`);
      if (this.closed) {
        return;
      }

      void this.replaceWorker(index);
    });

    return worker;
  }

  private async replaceWorker(index: number): Promise<void> {
    try {
      const replacement = await this.createWorker(index);
      this.workers[index] = replacement;
      console.log(`Mediasoup worker replaced at index ${index} (pid=${replacement.pid})`);
    } catch (error) {
      console.error("Failed to replace mediasoup worker", error);
    }
  }
}
