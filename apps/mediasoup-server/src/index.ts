import { config } from "./config.js";
import { WorkerPool } from "./mediasoup/worker-pool.js";
import { RoomRegistry } from "./rooms/rooms.js";
import { createWsServer } from "./ws.js";

const main = async (): Promise<void> => {
  const workerPool = new WorkerPool({
    workerCount: config.workerCount,
    rtcMinPort: config.rtcMinPort,
    rtcMaxPort: config.rtcMaxPort,
  });

  await workerPool.init();

  const rooms = new RoomRegistry(workerPool, {
    listenIp: config.listenIp,
    announcedAddress: config.announcedAddress,
    initialAvailableOutgoingBitrate: config.initialAvailableOutgoingBitrate,
    iceServers: config.iceServers,
    iceTransportPolicy: config.iceTransportPolicy,
  });

  const wsServer = await createWsServer(config, rooms);

  console.log(`Mediasoup server listening on ${wsServer.address}`);
  console.log(
    `Workers=${config.workerCount}, listenIp=${config.listenIp}, announcedAddress=${config.announcedAddress ?? "none"}`,
  );
  console.log(`RTP port range=${config.rtcMinPort}-${config.rtcMaxPort}`);

  const shutdown = async () => {
    try {
      await wsServer.close();
      rooms.closeAll();
      await workerPool.close();
    } catch (error) {
      console.error("Error while shutting down mediasoup server", error);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
};

void main().catch(error => {
  console.error("Failed to start mediasoup server", error);
  process.exit(1);
});
