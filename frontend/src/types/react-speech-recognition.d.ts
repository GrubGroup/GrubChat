// react-speech-recognition ships no type declarations. Minimal ambient types
// covering the surface we use in hooks/useVoiceInput.ts.
declare module 'react-speech-recognition' {
  export interface ListeningOptions {
    continuous?: boolean
    language?: string
  }

  export function useSpeechRecognition(): {
    transcript: string
    listening: boolean
    resetTranscript: () => void
    browserSupportsSpeechRecognition: boolean
    // True until the browser denies the mic permission prompt (then false).
    isMicrophoneAvailable: boolean
    // False on browsers (e.g. Android Chrome) where continuous mode misbehaves.
    browserSupportsContinuousListening: boolean
  }

  const SpeechRecognition: {
    startListening: (options?: ListeningOptions) => Promise<void>
    stopListening: () => Promise<void>
    abortListening: () => Promise<void>
  }

  export default SpeechRecognition
}
