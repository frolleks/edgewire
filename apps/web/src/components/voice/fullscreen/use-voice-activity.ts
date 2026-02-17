import type { UserSummary } from "@discord/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type VoiceActivityPeer = {
  socketId: string;
  user: UserSummary;
  isSelf?: boolean;
};

type UseVoiceActivityInput = {
  peers: VoiceActivityPeer[];
  remoteAudioStreamsByPeer: Record<string, MediaStream | undefined>;
  localAudioStream?: MediaStream;
};

type AnalyzerEntry = {
  stream: MediaStream;
  trackId: string;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
  speaking: boolean;
  belowSinceMs: number | null;
  level: number;
};

const LEVEL_GAIN = 4.2;
const SPEAK_ON_THRESHOLD = 0.06;
const SPEAK_OFF_THRESHOLD = 0.035;
const HOLD_MS = 320;
const SAMPLE_INTERVAL_MS = 80;
const LEVEL_EPSILON = 0.02;

const getAudioTrack = (stream: MediaStream | undefined): MediaStreamTrack | null => {
  if (!stream) {
    return null;
  }

  const liveTrack =
    stream
      .getAudioTracks()
      .find((track) => track.readyState === "live") ?? null;
  return liveTrack;
};

const asAudioContextConstructor = (): (new () => AudioContext) | null => {
  if (typeof window === "undefined") {
    return null;
  }

  const withWebkit = window as Window & {
    webkitAudioContext?: new () => AudioContext;
  };

  return window.AudioContext ?? withWebkit.webkitAudioContext ?? null;
};

const boolRecordEqual = (
  a: Record<string, boolean>,
  b: Record<string, boolean>,
): boolean => {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (a[key] !== b[key]) {
      return false;
    }
  }

  return true;
};

const numberRecordApproxEqual = (
  a: Record<string, number>,
  b: Record<string, number>,
): boolean => {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (Math.abs((a[key] ?? 0) - (b[key] ?? 0)) > LEVEL_EPSILON) {
      return false;
    }
  }

  return true;
};

export const useVoiceActivity = ({
  peers,
  remoteAudioStreamsByPeer,
  localAudioStream,
}: UseVoiceActivityInput): {
  speakingByPeer: Record<string, boolean>;
  levelByPeer: Record<string, number>;
} => {
  const [speakingByPeer, setSpeakingByPeer] = useState<Record<string, boolean>>(
    {},
  );
  const [levelByPeer, setLevelByPeer] = useState<Record<string, number>>({});
  const userActivation = (
    typeof document !== "undefined"
      ? (document as Document & {
          userActivation?: { hasBeenActive?: boolean };
        }).userActivation
      : undefined
  );

  const [activityEnabled, setActivityEnabled] = useState<boolean>(() =>
    Boolean(userActivation?.hasBeenActive),
  );

  const speakingRef = useRef<Record<string, boolean>>({});
  const levelsRef = useRef<Record<string, number>>({});
  const peersRef = useRef(peers);
  const remoteStreamsRef = useRef(remoteAudioStreamsByPeer);
  const localAudioStreamRef = useRef(localAudioStream);
  const activityEnabledRef = useRef(activityEnabled);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyzersRef = useRef<Map<string, AnalyzerEntry>>(new Map());
  const intervalIdRef = useRef<number | null>(null);

  peersRef.current = peers;
  remoteStreamsRef.current = remoteAudioStreamsByPeer;
  localAudioStreamRef.current = localAudioStream;
  activityEnabledRef.current = activityEnabled;

  const anyStreamAvailable = useMemo(
    () =>
      peers.some((peer) => {
        const stream = peer.isSelf
          ? localAudioStream
          : remoteAudioStreamsByPeer[peer.socketId];
        return Boolean(getAudioTrack(stream));
      }),
    [localAudioStream, peers, remoteAudioStreamsByPeer],
  );

  const stopLoop = useCallback(() => {
    if (intervalIdRef.current !== null) {
      window.clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }
  }, []);

  const disconnectEntry = useCallback((entry: AnalyzerEntry) => {
    try {
      entry.source.disconnect();
    } catch {
      // Ignore node disconnect errors during teardown.
    }
    try {
      entry.analyser.disconnect();
    } catch {
      // Ignore node disconnect errors during teardown.
    }
  }, []);

  const closeAudioContext = useCallback(() => {
    const context = audioContextRef.current;
    if (!context) {
      return;
    }

    audioContextRef.current = null;
    void context.close().catch(() => {
      // Ignore close errors; context may already be closed.
    });
  }, []);

  const ensureAudioContext = useCallback((): AudioContext | null => {
    if (audioContextRef.current) {
      return audioContextRef.current;
    }

    const ContextCtor = asAudioContextConstructor();
    if (!ContextCtor) {
      return null;
    }

    const context = new ContextCtor();
    audioContextRef.current = context;
    return context;
  }, []);

  const getStreamForPeer = useCallback((peer: VoiceActivityPeer) => {
    if (peer.isSelf) {
      return localAudioStreamRef.current;
    }
    return remoteStreamsRef.current[peer.socketId];
  }, []);

  const updateActivityState = useCallback(() => {
    const now = Date.now();
    const nextSpeaking: Record<string, boolean> = {};
    const nextLevels: Record<string, number> = {};

    for (const peer of peersRef.current) {
      const key = peer.socketId;
      const entry = analyzersRef.current.get(key);
      if (!entry) {
        nextSpeaking[key] = false;
        nextLevels[key] = 0;
        continue;
      }

      const matchingTrack =
        entry.stream.getAudioTracks().find((track) => track.id === entry.trackId) ??
        null;

      if (
        !matchingTrack ||
        matchingTrack.readyState !== "live" ||
        matchingTrack.muted
      ) {
        entry.speaking = false;
        entry.belowSinceMs = null;
        entry.level = 0;
        nextSpeaking[key] = false;
        nextLevels[key] = 0;
        continue;
      }

      entry.analyser.getByteTimeDomainData(entry.data);
      let sumSquares = 0;
      for (const sample of entry.data) {
        const value = (sample - 128) / 128;
        sumSquares += value * value;
      }

      const rms = Math.sqrt(sumSquares / entry.data.length);
      const level = Math.max(0, Math.min(1, rms * LEVEL_GAIN));
      entry.level = level;

      if (level >= SPEAK_ON_THRESHOLD) {
        entry.speaking = true;
        entry.belowSinceMs = null;
      } else if (level <= SPEAK_OFF_THRESHOLD) {
        if (entry.speaking) {
          if (entry.belowSinceMs === null) {
            entry.belowSinceMs = now;
          } else if (now - entry.belowSinceMs >= HOLD_MS) {
            entry.speaking = false;
            entry.belowSinceMs = null;
          }
        }
      } else {
        entry.belowSinceMs = null;
      }

      nextSpeaking[key] = entry.speaking;
      nextLevels[key] = level;
    }

    if (!boolRecordEqual(speakingRef.current, nextSpeaking)) {
      speakingRef.current = nextSpeaking;
      setSpeakingByPeer(nextSpeaking);
    }

    if (!numberRecordApproxEqual(levelsRef.current, nextLevels)) {
      levelsRef.current = nextLevels;
      setLevelByPeer(nextLevels);
    }
  }, []);

  const syncAnalyzers = useCallback(() => {
    if (!activityEnabledRef.current) {
      return;
    }

    const context = ensureAudioContext();
    if (!context) {
      return;
    }

    void context.resume().catch(() => {
      // Ignore resume errors; browser policies can keep the context suspended.
    });

    const expectedIds = new Set<string>();

    for (const peer of peersRef.current) {
      const stream = getStreamForPeer(peer);
      const track = getAudioTrack(stream);
      const key = peer.socketId;

      if (!stream || !track || track.muted) {
        const stale = analyzersRef.current.get(key);
        if (stale) {
          disconnectEntry(stale);
          analyzersRef.current.delete(key);
        }
        continue;
      }

      expectedIds.add(key);
      const existing = analyzersRef.current.get(key);
      if (
        existing &&
        existing.stream === stream &&
        existing.trackId === track.id
      ) {
        continue;
      }

      if (existing) {
        disconnectEntry(existing);
        analyzersRef.current.delete(key);
      }

      try {
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);

        analyzersRef.current.set(key, {
          stream,
          trackId: track.id,
          source,
          analyser,
          data: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
          speaking: false,
          belowSinceMs: null,
          level: 0,
        });
      } catch {
        // Ignore stream binding failures for unsupported/invalid streams.
      }
    }

    for (const [key, entry] of analyzersRef.current.entries()) {
      if (expectedIds.has(key)) {
        continue;
      }
      disconnectEntry(entry);
      analyzersRef.current.delete(key);
    }

    if (analyzersRef.current.size > 0) {
      if (intervalIdRef.current === null) {
        intervalIdRef.current = window.setInterval(
          updateActivityState,
          SAMPLE_INTERVAL_MS,
        );
      }
      return;
    }

    stopLoop();
    speakingRef.current = {};
    levelsRef.current = {};
    setSpeakingByPeer({});
    setLevelByPeer({});

    if (!anyStreamAvailable) {
      closeAudioContext();
    }
  }, [
    anyStreamAvailable,
    closeAudioContext,
    disconnectEntry,
    ensureAudioContext,
    getStreamForPeer,
    stopLoop,
    updateActivityState,
  ]);

  useEffect(() => {
    if (activityEnabled) {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const enable = () => {
      setActivityEnabled(true);
    };

    window.addEventListener("pointerdown", enable, { passive: true });
    window.addEventListener("touchstart", enable, { passive: true });
    window.addEventListener("keydown", enable);

    return () => {
      window.removeEventListener("pointerdown", enable);
      window.removeEventListener("touchstart", enable);
      window.removeEventListener("keydown", enable);
    };
  }, [activityEnabled]);

  useEffect(() => {
    if (!activityEnabled) {
      return;
    }

    syncAnalyzers();
    updateActivityState();
  }, [
    activityEnabled,
    localAudioStream,
    peers,
    remoteAudioStreamsByPeer,
    syncAnalyzers,
    updateActivityState,
  ]);

  useEffect(
    () => () => {
      stopLoop();
      for (const entry of analyzersRef.current.values()) {
        disconnectEntry(entry);
      }
      analyzersRef.current.clear();
      closeAudioContext();
    },
    [closeAudioContext, disconnectEntry, stopLoop],
  );

  return {
    speakingByPeer,
    levelByPeer,
  };
};

export default useVoiceActivity;
