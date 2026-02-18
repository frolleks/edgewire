import type { Device, types } from "mediasoup-client";
import type { MediasoupSignaling } from "./signaling";
import type { TransportOptions } from "./types";

type TransportDebugEvent =
  | "transport_created"
  | "transport_connect_start"
  | "transport_connect_done"
  | "transport_connect_error"
  | "transport_connection_state"
  | "produce_start"
  | "produce_done"
  | "produce_error";

type TransportCallbacks = {
  onDebug?: (event: TransportDebugEvent, payload: Record<string, unknown>) => void;
  onConnectionStateChange?: (direction: "send" | "recv", state: string) => void;
};

const buildTransportOptions = (
  options: TransportOptions,
  fallbackIceServers: RTCIceServer[] | undefined,
): types.TransportOptions => {
  return {
    id: options.id,
    iceParameters: options.iceParameters as types.IceParameters,
    iceCandidates: options.iceCandidates as types.IceCandidate[],
    dtlsParameters: options.dtlsParameters as types.DtlsParameters,
    ...(options.sctpParameters ? { sctpParameters: options.sctpParameters as types.SctpParameters } : {}),
    iceServers: options.iceServers ?? fallbackIceServers,
    ...(options.iceTransportPolicy ? { iceTransportPolicy: options.iceTransportPolicy } : {}),
  };
};

export const createSendTransport = async (
  signaling: MediasoupSignaling,
  device: Device,
  iceServers: RTCIceServer[] | undefined,
  callbacks?: TransportCallbacks,
): Promise<types.Transport> => {
  const serverOptions = await signaling.request<TransportOptions>("createWebRtcTransport", {
    direction: "send",
  });

  const transport = device.createSendTransport(buildTransportOptions(serverOptions, iceServers));
  callbacks?.onDebug?.("transport_created", {
    direction: "send",
    transportId: transport.id,
  });

  transport.on("connect", ({ dtlsParameters }, callback, errback) => {
    callbacks?.onDebug?.("transport_connect_start", {
      direction: "send",
      transportId: transport.id,
    });
    void signaling
      .request("connectWebRtcTransport", {
        transportId: transport.id,
        dtlsParameters,
      })
      .then(() => {
        callbacks?.onDebug?.("transport_connect_done", {
          direction: "send",
          transportId: transport.id,
        });
        callback();
      })
      .catch(error => {
        callbacks?.onDebug?.("transport_connect_error", {
          direction: "send",
          transportId: transport.id,
          error: error instanceof Error ? error.message : String(error),
        });
        errback(error as Error);
      });
  });

  transport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
    callbacks?.onDebug?.("produce_start", {
      transportId: transport.id,
      kind,
      source: appData?.source,
    });
    void signaling
      .request<{ producerId: string }>("produce", {
        transportId: transport.id,
        kind,
        rtpParameters,
        appData: appData ?? {},
      })
      .then(({ producerId }) => {
        callbacks?.onDebug?.("produce_done", {
          transportId: transport.id,
          producerId,
          kind,
          source: appData?.source,
        });
        callback({ id: producerId });
      })
      .catch(error => {
        callbacks?.onDebug?.("produce_error", {
          transportId: transport.id,
          kind,
          source: appData?.source,
          error: error instanceof Error ? error.message : String(error),
        });
        errback(error as Error);
      });
  });

  transport.on("connectionstatechange", state => {
    callbacks?.onDebug?.("transport_connection_state", {
      direction: "send",
      transportId: transport.id,
      state,
    });
    callbacks?.onConnectionStateChange?.("send", state);
  });

  return transport;
};

export const createRecvTransport = async (
  signaling: MediasoupSignaling,
  device: Device,
  iceServers: RTCIceServer[] | undefined,
  callbacks?: TransportCallbacks,
): Promise<types.Transport> => {
  const serverOptions = await signaling.request<TransportOptions>("createWebRtcTransport", {
    direction: "recv",
  });

  const transport = device.createRecvTransport(buildTransportOptions(serverOptions, iceServers));
  callbacks?.onDebug?.("transport_created", {
    direction: "recv",
    transportId: transport.id,
  });

  transport.on("connect", ({ dtlsParameters }, callback, errback) => {
    callbacks?.onDebug?.("transport_connect_start", {
      direction: "recv",
      transportId: transport.id,
    });
    void signaling
      .request("connectWebRtcTransport", {
        transportId: transport.id,
        dtlsParameters,
      })
      .then(() => {
        callbacks?.onDebug?.("transport_connect_done", {
          direction: "recv",
          transportId: transport.id,
        });
        callback();
      })
      .catch(error => {
        callbacks?.onDebug?.("transport_connect_error", {
          direction: "recv",
          transportId: transport.id,
          error: error instanceof Error ? error.message : String(error),
        });
        errback(error as Error);
      });
  });

  transport.on("connectionstatechange", state => {
    callbacks?.onDebug?.("transport_connection_state", {
      direction: "recv",
      transportId: transport.id,
      state,
    });
    callbacks?.onConnectionStateChange?.("recv", state);
  });

  return transport;
};
