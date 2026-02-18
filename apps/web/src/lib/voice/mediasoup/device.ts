import { Device } from "mediasoup-client";

export const createLoadedDevice = async (routerRtpCapabilities: unknown): Promise<Device> => {
  const device = new Device();
  await device.load({ routerRtpCapabilities: routerRtpCapabilities as Parameters<Device["load"]>[0]["routerRtpCapabilities"] });
  return device;
};
