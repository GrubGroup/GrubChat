import { useCallback } from 'react'
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition'

// Thin wrapper over react-speech-recognition so components depend on our API,
// not the library directly. `supported` lets the UI fall back to text input.
export function useVoiceInput() {
  const {
    transcript,
    listening,
    resetTranscript,
    browserSupportsSpeechRecognition,
    browserSupportsContinuousListening,
    isMicrophoneAvailable,
  } = useSpeechRecognition()

  const start = useCallback(() => {
    // Continuous keeps the mic open across natural pauses on desktop (v4 auto-restarts
    // on the native `end` event). Android Chrome instead restarts constantly and beeps
    // in continuous mode, so gate it on the library's own capability flag (false on
    // Android) and fall back to press-to-talk there.
    void SpeechRecognition.startListening({ continuous: browserSupportsContinuousListening })
  }, [browserSupportsContinuousListening])

  const stop = useCallback(() => {
    void SpeechRecognition.stopListening()
  }, [])

  return {
    transcript,
    listening,
    resetTranscript,
    supported: browserSupportsSpeechRecognition,
    // Starts true; flips false only after the user DENIES the mic permission prompt.
    // Lets the composer surface a "mic blocked" hint instead of a dead button.
    micAvailable: isMicrophoneAvailable,
    start,
    stop,
  }
}
