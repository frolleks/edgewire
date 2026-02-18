import { USE_MEDIASOUP_VOICE } from "@/lib/env";
import { useVoiceMediasoup } from "./use-voice-mediasoup";
import { useVoice as useVoiceMesh } from "./use-voice-mesh";

export const useVoice = USE_MEDIASOUP_VOICE ? useVoiceMediasoup : useVoiceMesh;
