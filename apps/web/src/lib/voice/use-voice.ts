import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type VoiceTokenResponse } from "@/lib/api";
import {
  type PeerLinkState,
  type VoiceConnectionStatus,
  type VoiceJoinPhase,
  type VoicePeer,
  type VoicePeerState,
} from "./types";
import { VoiceClient } from "./voice-client";
import { WebRtcMesh } from "./webrtc";

type JoinVoiceInput =
  | { kind: "guild"; guildId: string; channelId: string; channelName: string }
  | { kind: "dm"; channelId: string; channelName: string };

type VoiceState = {
  connected: boolean;
  roomId: string | null;
  channelId: string | null;
  channelName: string | null;
  lastDisconnectedChannelId: string | null;
  joiningChannelId: string | null;
  selfSocketId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  screenSharing: boolean;
  localScreenStream: MediaStream | null;
  peers: Record<string, VoicePeer>;
  screenStreams: Record<string, MediaStream>;
  status: VoiceConnectionStatus;
};

const now = (): number => Date.now();

const createStatus = (phase: VoiceJoinPhase = "idle"): VoiceConnectionStatus => {
  const ts = now();
  return {
    phase,
    startedAt: ts,
    lastTransitionAt: ts,
    ws: { state: "closed" },
    media: { mic: "unknown", hasLocalAudioTrack: false },
    peers: {
      total: 0,
      connected: 0,
      connecting: 0,
      failed: 0,
      bySocketId: {},
    },
  };
};

const emptyVoiceState: VoiceState = {
  connected: false,
  roomId: null,
  channelId: null,
  channelName: null,
  lastDisconnectedChannelId: null,
  joiningChannelId: null,
  selfSocketId: null,
  selfMute: false,
  selfDeaf: false,
  screenSharing: false,
  localScreenStream: null,
  peers: {},
  screenStreams: {},
  status: createStatus("idle"),
};

const nextPeerStats = (bySocketId: VoiceConnectionStatus["peers"]["bySocketId"]) => {
  const values = Object.values(bySocketId);
  return {
    total: values.length,
    connected: values.filter(value => value.state === "connected").length,
    connecting: values.filter(value => value.state === "new" || value.state === "connecting").length,
    failed: values.filter(value => value.state === "failed" || value.state === "disconnected").length,
  };
};

const closeMessage = (code: number, reason: string): { code: string; message: string; detail?: string } => {
  if (code === 4001) {
    return { code: "invalid_token", message: "Voice token is invalid.", detail: reason };
  }
  if (code === 4002) {
    return { code: "expired_token", message: "Voice token expired.", detail: reason };
  }
  if (code === 4003) {
    return { code: "not_authorized", message: "Not authorized for this room.", detail: reason };
  }
  if (code === 4100) {
    return { code: "server_shutdown", message: "Voice server shutting down.", detail: reason };
  }
  return { code: "socket_closed", message: "Voice connection closed.", detail: reason };
};

export const useVoice = () => {
  const [state, setState] = useState<VoiceState>(emptyVoiceState);

  const clientRef = useRef<VoiceClient | null>(null);
  const webRtcRef = useRef<WebRtcMesh | null>(null);
  const localAudioStreamRef = useRef<MediaStream | null>(null);
  const localScreenTrackRef = useRef<MediaStreamTrack | null>(null);
  const remoteAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const selfSocketIdRef = useRef<string | null>(null);
  const joinAttemptIdRef = useRef(0);
  const lastJoinInputRef = useRef<JoinVoiceInput | null>(null);

  const setPhase = useCallback((phase: VoiceJoinPhase) => {
    setState(current => ({
      ...current,
      status: {
        ...current.status,
        phase,
        lastTransitionAt: now(),
      },
    }));
  }, []);

  const setFailure = useCallback((error: { code: string; message: string; detail?: string }) => {
    setState(current => ({
      ...current,
      connected: false,
      status: {
        ...current.status,
        phase: "failed",
        lastTransitionAt: now(),
        error,
      },
    }));
  }, []);

  const attachRemoteAudio = useCallback((peerSocketId: string, stream: MediaStream): void => {
    let audio = remoteAudiosRef.current.get(peerSocketId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      remoteAudiosRef.current.set(peerSocketId, audio);
    }
    audio.srcObject = stream;
    audio.muted = state.selfDeaf;
    void audio.play().catch(() => undefined);
  }, [state.selfDeaf]);

  const clearRemotePeer = useCallback((peerSocketId: string): void => {
    const audio = remoteAudiosRef.current.get(peerSocketId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      remoteAudiosRef.current.delete(peerSocketId);
    }

    setState(current => {
      const nextPeers = { ...current.peers };
      const nextScreens = { ...current.screenStreams };
      const nextPeerStatuses = { ...current.status.peers.bySocketId };
      delete nextPeers[peerSocketId];
      delete nextScreens[peerSocketId];
      delete nextPeerStatuses[peerSocketId];

      return {
        ...current,
        peers: nextPeers,
        screenStreams: nextScreens,
        status: {
          ...current.status,
          peers: {
            ...current.status.peers,
            ...nextPeerStats(nextPeerStatuses),
            bySocketId: nextPeerStatuses,
          },
        },
      };
    });

    webRtcRef.current?.removePeer(peerSocketId);
  }, []);

  const updatePeerLinkState = useCallback((peerSocketId: string, peerState: PeerLinkState, ice: string) => {
    setState(current => {
      const nextBySocketId = {
        ...current.status.peers.bySocketId,
        [peerSocketId]: {
          state: peerState,
          ice,
          lastChangeAt: now(),
        },
      };

      const stats = nextPeerStats(nextBySocketId);
      const nextPhase =
        current.status.phase === "negotiating_peers" && (stats.total === 0 || stats.connected > 0)
          ? "connected"
          : current.status.phase;

      return {
        ...current,
        connected: nextPhase === "connected" || current.connected,
        status: {
          ...current.status,
          phase: nextPhase,
          peers: {
            ...current.status.peers,
            ...stats,
            bySocketId: nextBySocketId,
          },
        },
      };
    });
  }, []);

  const leave = useCallback(() => {
    const disconnectedChannelId = state.channelId;
    joinAttemptIdRef.current += 1;
    setState(current => ({
      ...current,
      status: {
        ...current.status,
        phase: current.status.phase === "idle" ? "idle" : "leaving",
        lastTransitionAt: now(),
      },
    }));

    clientRef.current?.send("LEAVE", {});
    clientRef.current?.close();
    clientRef.current = null;

    webRtcRef.current?.closeAll();
    webRtcRef.current = null;

    if (localScreenTrackRef.current) {
      localScreenTrackRef.current.stop();
      localScreenTrackRef.current = null;
    }

    if (localAudioStreamRef.current) {
      localAudioStreamRef.current.getTracks().forEach(track => track.stop());
      localAudioStreamRef.current = null;
    }

    for (const audio of remoteAudiosRef.current.values()) {
      audio.pause();
      audio.srcObject = null;
    }
    remoteAudiosRef.current.clear();
    selfSocketIdRef.current = null;

    setState({
      ...emptyVoiceState,
      lastDisconnectedChannelId: disconnectedChannelId,
      status: createStatus("idle"),
    });
  }, [state.channelId]);

  const connect = useCallback(async (tokenData: VoiceTokenResponse, input: JoinVoiceInput, joinAttemptId: number): Promise<void> => {
    const webrtc = new WebRtcMesh({
      iceServers: tokenData.ice_servers,
      localAudioStream: localAudioStreamRef.current,
      onIceCandidate: (to, candidate) => {
        clientRef.current?.send("SIGNAL_ICE", { to, candidate });
      },
      onRemoteTrack: (peerSocketId, stream, track) => {
        if (track.kind === "audio") {
          attachRemoteAudio(peerSocketId, stream);
          return;
        }

        if (track.kind === "video") {
          setState(current => ({
            ...current,
            screenStreams: {
              ...current.screenStreams,
              [peerSocketId]: stream,
            },
          }));
        }
      },
      onPeerStateChange: (peerSocketId, peerState, ice) => {
        updatePeerLinkState(peerSocketId, peerState, ice);
      },
      onRenegotiate: (peerSocketId, offer) => {
        clientRef.current?.send("SIGNAL_OFFER", { to: peerSocketId, sdp: offer, restart: true });
      },
    });
    webRtcRef.current = webrtc;

    const client = new VoiceClient({
      wsUrl: tokenData.voice_ws_url,
      token: tokenData.token,
      autoReconnect: true,
      onWsStateChange: wsState => {
        setState(current => ({
          ...current,
          status: {
            ...current.status,
            phase:
              wsState === "connecting"
                ? current.connected
                  ? "reconnecting"
                  : "connecting_ws"
                : wsState === "open"
                  ? "authenticating"
                  : current.status.phase,
            ws: {
              ...current.status.ws,
              state: wsState,
            },
          },
        }));
      },
      onAuthOk: ({ room_id, self_socket_id }) => {
        if (joinAttemptIdRef.current !== joinAttemptId) {
          return;
        }

        setState(current => ({
          ...current,
          roomId: room_id,
          selfSocketId: self_socket_id,
          status: {
            ...current.status,
            phase: "joining_room",
            lastTransitionAt: now(),
          },
        }));
      },
      onPong: ({ rttMs, lastPongAt }) => {
        setState(current => ({
          ...current,
          status: {
            ...current.status,
            ws: {
              ...current.status.ws,
              rttMs,
              lastPongAt,
            },
          },
        }));
      },
      onClose: ({ code, reason, willRetry }) => {
        if (willRetry) {
          setPhase("reconnecting");
          webRtcRef.current?.closeAll();
          for (const audio of remoteAudiosRef.current.values()) {
            audio.pause();
            audio.srcObject = null;
          }
          remoteAudiosRef.current.clear();
          setState(current => ({
            ...current,
            peers: {},
            screenStreams: {},
            localScreenStream: null,
            status: {
              ...current.status,
              peers: {
                ...current.status.peers,
                total: 0,
                connected: 0,
                connecting: 0,
                failed: 0,
                bySocketId: {},
              },
            },
          }));
          return;
        }

        const error = closeMessage(code, reason);
        setState(current => {
          if (current.status.phase === "idle" || current.status.phase === "leaving") {
            return current;
          }

          return {
            ...current,
            connected: false,
            status: {
              ...current.status,
              phase: "failed",
              lastTransitionAt: now(),
              error,
            },
          };
        });
      },
      onReady: async ({ self, room, peers }) => {
        if (joinAttemptIdRef.current !== joinAttemptId) {
          return;
        }

        selfSocketIdRef.current = self.socketId;
        setState(current => {
          const nextPeers: Record<string, VoicePeer> = {};
          const bySocketId: VoiceConnectionStatus["peers"]["bySocketId"] = {};
          for (const peer of peers) {
            nextPeers[peer.socketId] = peer;
            bySocketId[peer.socketId] = {
              state: "new",
              ice: "new",
              lastChangeAt: now(),
            };
          }

          const stats = nextPeerStats(bySocketId);
          const phase = stats.total === 0 ? "connected" : "negotiating_peers";
          return {
            ...current,
            connected: phase === "connected",
            roomId: room.roomId,
            channelId: input.channelId,
            channelName: input.channelName,
            joiningChannelId: null,
            selfSocketId: self.socketId,
            peers: nextPeers,
            status: {
              ...current.status,
              phase,
              lastTransitionAt: now(),
              peers: {
                ...current.status.peers,
                ...stats,
                bySocketId,
              },
            },
          };
        });

        for (const peer of peers) {
          if (self.socketId.localeCompare(peer.socketId) > 0) {
            const offer = await webrtc.createOffer(peer.socketId);
            client.send("SIGNAL_OFFER", { to: peer.socketId, sdp: offer });
          }
        }
      },
      onPeerJoined: async peer => {
        if (joinAttemptIdRef.current !== joinAttemptId) {
          return;
        }

        setState(current => {
          const nextBySocketId = {
            ...current.status.peers.bySocketId,
            [peer.socketId]: {
              state: "new" as PeerLinkState,
              ice: "new",
              lastChangeAt: now(),
            },
          };
          return {
            ...current,
            peers: {
              ...current.peers,
              [peer.socketId]: peer,
            },
            status: {
              ...current.status,
              phase: current.status.phase === "connected" ? "negotiating_peers" : current.status.phase,
              peers: {
                ...current.status.peers,
                ...nextPeerStats(nextBySocketId),
                bySocketId: nextBySocketId,
              },
            },
          };
        });

        const selfSocketId = selfSocketIdRef.current;
        if (selfSocketId && selfSocketId.localeCompare(peer.socketId) > 0) {
          const offer = await webrtc.createOffer(peer.socketId);
          client.send("SIGNAL_OFFER", { to: peer.socketId, sdp: offer });
        }
      },
      onPeerLeft: socketId => {
        clearRemotePeer(socketId);
      },
      onPeerStateUpdate: (socketId, peerState) => {
        setState(current => {
          const peer = current.peers[socketId];
          if (!peer) {
            return current;
          }

          const nextScreens = { ...current.screenStreams };
          if (!peerState.screen_sharing) {
            delete nextScreens[socketId];
          }

          return {
            ...current,
            screenStreams: nextScreens,
            peers: {
              ...current.peers,
              [socketId]: {
                ...peer,
                state: peerState,
              },
            },
          };
        });
      },
      onSignalOffer: async ({ from, sdp }) => {
        const answer = await webrtc.handleOffer(from, sdp);
        client.send("SIGNAL_ANSWER", { to: from, sdp: answer });
      },
      onSignalAnswer: async ({ from, sdp }) => {
        await webrtc.handleAnswer(from, sdp);
      },
      onSignalIce: async ({ from, candidate }) => {
        await webrtc.addIceCandidate(from, candidate);
      },
      onError: message => {
        setFailure({ code: "voice_error", message });
      },
    });

    clientRef.current = client;
    client.connect();
  }, [attachRemoteAudio, clearRemotePeer, setFailure, setPhase, updatePeerLinkState]);

  const join = useCallback(async (input: JoinVoiceInput) => {
    leave();
    lastJoinInputRef.current = input;
    const joinAttemptId = joinAttemptIdRef.current;
    const startedAt = now();

    setState(current => ({
      ...current,
      channelId: input.channelId,
      channelName: input.channelName,
      lastDisconnectedChannelId: null,
      joiningChannelId: input.channelId,
      status: {
        ...createStatus("requesting_token"),
        startedAt,
        media: {
          ...createStatus().media,
          mic: "prompting",
        },
      },
    }));

    const tokenPromise = api.getVoiceToken({
      kind: input.kind,
      guild_id: input.kind === "guild" ? input.guildId : undefined,
      channel_id: input.channelId,
    });

    const micPromise = navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then(stream => ({ stream }))
      .catch(error => ({ error }));

    const tokenResult = await tokenPromise.then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    );
    if (joinAttemptIdRef.current !== joinAttemptId) {
      return;
    }

    if (!tokenResult.ok) {
      setFailure({
        code: "token_failed",
        message: tokenResult.error instanceof Error ? tokenResult.error.message : "Could not get voice token.",
      });
      return;
    }

    setPhase("connecting_ws");
    try {
      await connect(tokenResult.value, input, joinAttemptId);
    } catch (error) {
      setFailure({
        code: "connect_failed",
        message: error instanceof Error ? error.message : "Could not connect to voice.",
      });
    }

    void micPromise.then(micResult => {
      if (joinAttemptIdRef.current !== joinAttemptId) {
        if ("stream" in micResult && micResult.stream) {
          micResult.stream.getTracks().forEach(track => track.stop());
        }
        return;
      }

      if ("stream" in micResult && micResult.stream) {
        localAudioStreamRef.current = micResult.stream;
        const track = micResult.stream.getAudioTracks()[0] ?? null;
        webRtcRef.current?.setLocalAudioTrack(track, micResult.stream);
        setState(current => ({
          ...current,
          status: {
            ...current.status,
            media: {
              mic: "ready",
              hasLocalAudioTrack: Boolean(track),
            },
          },
        }));
        return;
      }

      localAudioStreamRef.current = null;
      setState(current => ({
        ...current,
        status: {
          ...current.status,
          media: {
            mic: "denied",
            hasLocalAudioTrack: false,
          },
        },
      }));
      toast.warning("Microphone blocked, you can still listen.");
    });
  }, [connect, leave, setFailure, setPhase]);

  const retryJoin = useCallback(() => {
    const input = lastJoinInputRef.current;
    if (!input) {
      return;
    }
    void join(input);
  }, [join]);

  const retryMicrophone = useCallback(async () => {
    try {
      setState(current => ({
        ...current,
        status: {
          ...current.status,
          phase: current.status.phase === "connected" ? "connected" : "acquiring_microphone",
          media: {
            ...current.status.media,
            mic: "prompting",
          },
        },
      }));

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      localAudioStreamRef.current = stream;
      const track = stream.getAudioTracks()[0] ?? null;
      webRtcRef.current?.setLocalAudioTrack(track, stream);
      setState(current => ({
        ...current,
        status: {
          ...current.status,
          media: {
            mic: "ready",
            hasLocalAudioTrack: Boolean(track),
          },
          phase: current.connected ? "connected" : current.status.phase,
        },
      }));
    } catch (error) {
      setState(current => ({
        ...current,
        status: {
          ...current.status,
          media: {
            ...current.status.media,
            mic: "denied",
            hasLocalAudioTrack: false,
          },
        },
      }));
      toast.error(error instanceof Error ? error.message : "Could not access microphone.");
    }
  }, []);

  const emitSelfState = useCallback((next: Partial<VoicePeerState>) => {
    const payload: VoicePeerState = {
      self_mute: next.self_mute ?? state.selfMute,
      self_deaf: next.self_deaf ?? state.selfDeaf,
      screen_sharing: next.screen_sharing ?? state.screenSharing,
    };
    clientRef.current?.sendState(payload);
  }, [state.selfDeaf, state.selfMute, state.screenSharing]);

  const toggleMute = useCallback(() => {
    const stream = localAudioStreamRef.current;
    if (stream) {
      const next = !state.selfMute;
      stream.getAudioTracks().forEach(track => {
        track.enabled = !next;
      });
    }
    setState(current => ({ ...current, selfMute: !current.selfMute }));
    emitSelfState({ self_mute: !state.selfMute });
  }, [emitSelfState, state.selfMute]);

  const toggleDeafen = useCallback(() => {
    const next = !state.selfDeaf;
    setState(current => ({ ...current, selfDeaf: next }));
    for (const audio of remoteAudiosRef.current.values()) {
      audio.muted = next;
    }
    emitSelfState({ self_deaf: next });
  }, [emitSelfState, state.selfDeaf]);

  const toggleScreenshare = useCallback(async () => {
    const webrtc = webRtcRef.current;
    if (!webrtc || state.status.phase !== "connected") {
      return;
    }

    if (localScreenTrackRef.current) {
      const track = localScreenTrackRef.current;
      track.stop();
      localScreenTrackRef.current = null;
      await webrtc.stopScreenshare();
      const offers = await webrtc.renegotiateAll();
      for (const { peerSocketId, offer } of offers) {
        clientRef.current?.send("SIGNAL_OFFER", { to: peerSocketId, sdp: offer, screen: false });
      }
      setState(current => ({ ...current, screenSharing: false }));
      setState(current => ({ ...current, localScreenStream: null }));
      emitSelfState({ screen_sharing: false });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) {
        return;
      }

      localScreenTrackRef.current = track;
      setState(current => ({ ...current, localScreenStream: stream }));
      track.onended = () => {
        void toggleScreenshare();
      };

      await webrtc.startScreenshare(track);
      const offers = await webrtc.renegotiateAll();
      for (const { peerSocketId, offer } of offers) {
        clientRef.current?.send("SIGNAL_OFFER", { to: peerSocketId, sdp: offer, screen: true });
      }
      setState(current => ({ ...current, screenSharing: true }));
      emitSelfState({ screen_sharing: true });
    } catch {
      toast.error("Could not start screenshare.");
    }
  }, [emitSelfState, state.status.phase]);

  const participants = useMemo(() => Object.values(state.peers), [state.peers]);

  const joinGuildVoice = useCallback(
    (guildId: string, channelId: string, channelName: string) =>
      join({ kind: "guild", guildId, channelId, channelName }),
    [join],
  );

  const joinDmVoice = useCallback(
    (channelId: string, channelName: string) => join({ kind: "dm", channelId, channelName }),
    [join],
  );

  return {
    ...state,
    participants,
    joinGuildVoice,
    joinDmVoice,
    retryJoin,
    retryMicrophone,
    toggleMute,
    toggleDeafen,
    toggleScreenshare,
    disconnect: leave,
  };
};
