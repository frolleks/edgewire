import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type VoiceTokenResponse } from "@/lib/api";
import { DEBUG_VOICE } from "@/lib/env";
import {
  type PeerLinkState,
  type VoiceConnectionStatus,
  type VoiceJoinPhase,
  type VoicePeer,
  type VoicePeerState,
} from "./types";
import { MediasoupVoiceClient } from "./mediasoup/client";

type JoinVoiceInput =
  | { kind: "guild"; guildId: string; channelId: string; channelName: string }
  | { kind: "dm"; channelId: string; channelName: string };

type VoiceState = {
  connected: boolean;
  roomId: string | null;
  channelId: string | null;
  channelName: string | null;
  joiningChannelId: string | null;
  selfSocketId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  screenSharing: boolean;
  localAudioStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  peers: Record<string, VoicePeer>;
  remoteAudioStreams: Record<string, MediaStream>;
  screenStreams: Record<string, MediaStream>;
  audioPlaybackBlocked: boolean;
  transportStates: {
    send: string | null;
    recv: string | null;
  };
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
  joiningChannelId: null,
  selfSocketId: null,
  selfMute: false,
  selfDeaf: false,
  screenSharing: false,
  localAudioStream: null,
  localScreenStream: null,
  peers: {},
  remoteAudioStreams: {},
  screenStreams: {},
  audioPlaybackBlocked: false,
  transportStates: {
    send: null,
    recv: null,
  },
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
  if (code === 1006) {
    return { code: "socket_closed", message: "Voice connection dropped.", detail: reason };
  }

  return { code: "socket_closed", message: "Voice connection closed.", detail: reason };
};

export const useVoiceMediasoup = () => {
  const [state, setState] = useState<VoiceState>(emptyVoiceState);

  const clientRef = useRef<MediasoupVoiceClient | null>(null);
  const localAudioStreamRef = useRef<MediaStream | null>(null);
  const localScreenTrackRef = useRef<MediaStreamTrack | null>(null);
  const remoteAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const remoteVideosRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const joinAttemptIdRef = useRef(0);
  const lastJoinInputRef = useRef<JoinVoiceInput | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const joinRef = useRef<((input: JoinVoiceInput) => Promise<void>) | null>(null);

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
      audio.setAttribute("playsinline", "true");
      remoteAudiosRef.current.set(peerSocketId, audio);
    }
    audio.srcObject = stream;
    audio.muted = state.selfDeaf;

    setState(current => {
      if (current.remoteAudioStreams[peerSocketId] === stream && !current.audioPlaybackBlocked) {
        return current;
      }

      return {
        ...current,
        remoteAudioStreams: {
          ...current.remoteAudioStreams,
          [peerSocketId]: stream,
        },
        audioPlaybackBlocked: false,
      };
    });

    void audio.play().then(
      () => {
        if (DEBUG_VOICE) {
          console.debug("[voice] audio_play_ok", { peerId: peerSocketId });
        }
      },
      error => {
        if (DEBUG_VOICE) {
          console.debug("[voice] audio_play_error", {
            peerId: peerSocketId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        setState(current => ({
          ...current,
          audioPlaybackBlocked: true,
        }));
      },
    );
  }, [state.selfDeaf]);

  const clearRemotePeer = useCallback((peerSocketId: string): void => {
    const audio = remoteAudiosRef.current.get(peerSocketId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      remoteAudiosRef.current.delete(peerSocketId);
    }
    const video = remoteVideosRef.current.get(peerSocketId);
    if (video) {
      video.pause();
      video.srcObject = null;
      remoteVideosRef.current.delete(peerSocketId);
    }

    setState(current => {
      const nextPeers = { ...current.peers };
      const nextRemoteAudios = { ...current.remoteAudioStreams };
      const nextScreens = { ...current.screenStreams };
      const nextPeerStatuses = { ...current.status.peers.bySocketId };
      delete nextPeers[peerSocketId];
      delete nextRemoteAudios[peerSocketId];
      delete nextScreens[peerSocketId];
      delete nextPeerStatuses[peerSocketId];

      return {
        ...current,
        peers: nextPeers,
        remoteAudioStreams: nextRemoteAudios,
        screenStreams: nextScreens,
        audioPlaybackBlocked: remoteAudiosRef.current.size === 0 ? false : current.audioPlaybackBlocked,
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
  }, []);

  const closeClient = useCallback((stopTracks = true) => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    clientRef.current?.close();
    clientRef.current = null;

    if (localScreenTrackRef.current) {
      localScreenTrackRef.current.stop();
      localScreenTrackRef.current = null;
    }

    if (stopTracks && localAudioStreamRef.current) {
      localAudioStreamRef.current.getTracks().forEach(track => track.stop());
      localAudioStreamRef.current = null;
    }

    for (const audio of remoteAudiosRef.current.values()) {
      audio.pause();
      audio.srcObject = null;
    }
    remoteAudiosRef.current.clear();
    for (const video of remoteVideosRef.current.values()) {
      video.pause();
      video.srcObject = null;
    }
    remoteVideosRef.current.clear();
  }, []);

  const leave = useCallback(() => {
    joinAttemptIdRef.current += 1;
    setState(current => ({
      ...current,
      status: {
        ...current.status,
        phase: current.status.phase === "idle" ? "idle" : "leaving",
        lastTransitionAt: now(),
      },
    }));

    reconnectAttemptRef.current = 0;
    const currentClient = clientRef.current;
    clientRef.current = null;
    void currentClient?.leave();
    closeClient(true);

    setState({
      ...emptyVoiceState,
      status: createStatus("idle"),
    });
  }, [closeClient]);

  const connect = useCallback(async (tokenData: VoiceTokenResponse, input: JoinVoiceInput, joinAttemptId: number): Promise<void> => {
    const wsUrl = tokenData.mediasoup_ws_url || tokenData.voice_ws_url;
    if (!wsUrl) {
      throw new Error("Voice server URL missing from token response.");
    }

    const client = new MediasoupVoiceClient({
      wsUrl,
      token: tokenData.token,
      iceServers: tokenData.ice_servers,
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
      onIdentified: ({ roomId, selfPeerId }) => {
        if (joinAttemptIdRef.current !== joinAttemptId) {
          return;
        }

        setState(current => ({
          ...current,
          roomId,
          selfSocketId: selfPeerId,
          status: {
            ...current.status,
            phase: "joining_room",
            lastTransitionAt: now(),
          },
        }));
      },
      onJoined: ({ roomId, selfPeerId, peers }) => {
        if (joinAttemptIdRef.current !== joinAttemptId) {
          return;
        }

        reconnectAttemptRef.current = 0;

        const bySocketId: VoiceConnectionStatus["peers"]["bySocketId"] = {};
        const peerMap: Record<string, VoicePeer> = {};

        for (const peer of peers) {
          peerMap[peer.socketId] = peer;
          bySocketId[peer.socketId] = {
            state: "connected",
            ice: "connected",
            lastChangeAt: now(),
          };
        }

        setState(current => ({
          ...current,
          connected: true,
          roomId,
          channelId: input.channelId,
          channelName: input.channelName,
          joiningChannelId: null,
          selfSocketId: selfPeerId,
          peers: peerMap,
          status: {
            ...current.status,
            phase: "connected",
            lastTransitionAt: now(),
            peers: {
              ...current.status.peers,
              ...nextPeerStats(bySocketId),
              bySocketId,
            },
          },
        }));
      },
      onPeerJoined: peer => {
        if (joinAttemptIdRef.current !== joinAttemptId) {
          return;
        }

        setState(current => {
          const nextBySocketId = {
            ...current.status.peers.bySocketId,
            [peer.socketId]: {
              state: "connected" as PeerLinkState,
              ice: "connected",
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
              peers: {
                ...current.status.peers,
                ...nextPeerStats(nextBySocketId),
                bySocketId: nextBySocketId,
              },
            },
          };
        });
      },
      onPeerLeft: socketId => {
        clearRemotePeer(socketId);
      },
      onPeerStateUpdated: (socketId, peerState) => {
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
      onRemoteTrack: ({ peerId, source, track, stream }) => {
        if (source === "mic" || track.kind === "audio") {
          attachRemoteAudio(peerId, stream);
          return;
        }

        let video = remoteVideosRef.current.get(peerId);
        if (!video) {
          video = document.createElement("video");
          video.autoplay = true;
          video.playsInline = true;
          video.muted = true;
          remoteVideosRef.current.set(peerId, video);
        }
        video.srcObject = stream;

        void video.play().then(
          () => {
            if (DEBUG_VOICE) {
              console.debug("[voice] screen_play_ok", { peerId });
            }
          },
          error => {
            if (DEBUG_VOICE) {
              console.debug("[voice] screen_play_error", {
                peerId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        );

        setState(current => ({
          ...current,
          screenStreams: {
            ...current.screenStreams,
            [peerId]: stream,
          },
        }));
        return;
      },
      onTransportStateChange: ({ direction, state: transportState }) => {
        setState(current => ({
          ...current,
          transportStates: {
            ...current.transportStates,
            [direction]: transportState,
          },
        }));
      },
      onProducerClosed: ({ peerId, source }) => {
        if (source === "screen") {
          const video = remoteVideosRef.current.get(peerId);
          if (video) {
            video.pause();
            video.srcObject = null;
            remoteVideosRef.current.delete(peerId);
          }
          setState(current => {
            const nextScreens = { ...current.screenStreams };
            delete nextScreens[peerId];
            return {
              ...current,
              screenStreams: nextScreens,
            };
          });
          return;
        }

        const audio = remoteAudiosRef.current.get(peerId);
        if (audio) {
          audio.pause();
          audio.srcObject = null;
          remoteAudiosRef.current.delete(peerId);
        }

        setState(current => {
          const nextRemote = { ...current.remoteAudioStreams };
          delete nextRemote[peerId];
          return {
            ...current,
            remoteAudioStreams: nextRemote,
            audioPlaybackBlocked: remoteAudiosRef.current.size === 0 ? false : current.audioPlaybackBlocked,
          };
        });
      },
      onError: message => {
        setFailure({ code: "voice_error", message });
      },
      onClose: ({ code, reason, expected }) => {
        clientRef.current = null;
        if (expected) {
          return;
        }

        if (reconnectTimerRef.current !== null) {
          return;
        }

        const inputForRetry = lastJoinInputRef.current;
        if (!inputForRetry) {
          const error = closeMessage(code, reason);
          setFailure(error);
          return;
        }

        const backoff = [1_000, 2_000, 5_000, 10_000];
        const delay = backoff[Math.min(reconnectAttemptRef.current, backoff.length - 1)] ?? 10_000;
        reconnectAttemptRef.current += 1;

        for (const audio of remoteAudiosRef.current.values()) {
          audio.pause();
          audio.srcObject = null;
        }
        remoteAudiosRef.current.clear();
        for (const video of remoteVideosRef.current.values()) {
          video.pause();
          video.srcObject = null;
        }
        remoteVideosRef.current.clear();

        setState(current => ({
          ...current,
          connected: false,
          peers: {},
          remoteAudioStreams: {},
          screenStreams: {},
          audioPlaybackBlocked: false,
          transportStates: {
            send: null,
            recv: null,
          },
          localScreenStream: null,
          status: {
            ...current.status,
            phase: "reconnecting",
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

        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          void joinRef.current?.(inputForRetry);
        }, delay);
      },
    });

    clientRef.current = client;
    await client.connect();
  }, [attachRemoteAudio, clearRemotePeer, setFailure]);

  const join = useCallback(async (input: JoinVoiceInput) => {
    reconnectAttemptRef.current = 0;
    joinAttemptIdRef.current += 1;
    const joinAttemptId = joinAttemptIdRef.current;

    closeClient(true);
    lastJoinInputRef.current = input;

    const startedAt = now();
    setState({
      ...emptyVoiceState,
      channelId: input.channelId,
      channelName: input.channelName,
      joiningChannelId: input.channelId,
      status: {
        ...createStatus("requesting_token"),
        startedAt,
        media: {
          ...createStatus().media,
          mic: "prompting",
        },
      },
    });

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

    void micPromise.then(async micResult => {
      if (joinAttemptIdRef.current !== joinAttemptId) {
        if ("stream" in micResult && micResult.stream) {
          micResult.stream.getTracks().forEach(track => track.stop());
        }
        return;
      }

      if ("stream" in micResult && micResult.stream) {
        localAudioStreamRef.current = micResult.stream;
        const track = micResult.stream.getAudioTracks()[0] ?? null;
        if (track) {
          track.enabled = !state.selfMute;
          try {
            await clientRef.current?.produceMic(track);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Could not send microphone audio.";
            toast.error(message);
          }
        }

        setState(current => ({
          ...current,
          localAudioStream: micResult.stream,
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
        localAudioStream: null,
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
  }, [closeClient, connect, setFailure, setPhase, state.selfMute]);

  joinRef.current = join;

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

      if (localAudioStreamRef.current) {
        localAudioStreamRef.current.getTracks().forEach(track => track.stop());
      }

      localAudioStreamRef.current = stream;
      const track = stream.getAudioTracks()[0] ?? null;
      if (track) {
        track.enabled = !state.selfMute;
        try {
          await clientRef.current?.produceMic(track);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not send microphone audio.";
          toast.error(message);
        }
      }

      setState(current => ({
        ...current,
        localAudioStream: stream,
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
        localAudioStream: null,
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
  }, [state.selfMute]);

  const enableAudioPlayback = useCallback(async () => {
    const attempts = [...remoteAudiosRef.current.values()].map(audio =>
      audio.play().then(
        () => true,
        error => {
          if (DEBUG_VOICE) {
            console.debug("[voice] audio_play_retry_error", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return false;
        },
      ),
    );

    const results = await Promise.all(attempts);
    const blocked = results.some(result => !result);

    setState(current => ({
      ...current,
      audioPlaybackBlocked: blocked,
    }));

    if (DEBUG_VOICE && !blocked) {
      console.debug("[voice] audio_play_retry_ok");
    }
  }, []);

  const emitSelfState = useCallback((next: Partial<VoicePeerState>) => {
    const payload: VoicePeerState = {
      self_mute: next.self_mute ?? state.selfMute,
      self_deaf: next.self_deaf ?? state.selfDeaf,
      screen_sharing: next.screen_sharing ?? state.screenSharing,
    };

    void clientRef.current?.updatePeerState(payload);
  }, [state.selfDeaf, state.selfMute, state.screenSharing]);

  const toggleMute = useCallback(() => {
    const next = !state.selfMute;
    const stream = localAudioStreamRef.current;
    if (stream) {
      stream.getAudioTracks().forEach(track => {
        track.enabled = !next;
      });
    }

    setState(current => ({ ...current, selfMute: next }));
    emitSelfState({ self_mute: next });
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
    const client = clientRef.current;
    if (!client || state.status.phase !== "connected") {
      return;
    }

    if (localScreenTrackRef.current) {
      localScreenTrackRef.current.stop();
      localScreenTrackRef.current = null;

      await client.closeScreenProducer();
      setState(current => ({
        ...current,
        screenSharing: false,
        localScreenStream: null,
      }));
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

      const displaySurface = track.getSettings().displaySurface;
      await client.produceScreen(track, typeof displaySurface === "string" ? displaySurface : undefined);

      setState(current => ({ ...current, screenSharing: true }));
      emitSelfState({ screen_sharing: true });
    } catch {
      toast.error("Could not start screenshare.");
    }
  }, [emitSelfState, state.status.phase]);

  const participants = useMemo(() => Object.values(state.peers), [state.peers]);

  const joinGuildVoice = useCallback(
    (guildId: string, channelId: string, channelName: string) => join({ kind: "guild", guildId, channelId, channelName }),
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
    enableAudioPlayback,
    toggleMute,
    toggleDeafen,
    toggleScreenshare,
    disconnect: leave,
  };
};
