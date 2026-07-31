import axios from 'axios'
import { api } from '@/lib/axios'

// Voice endpoints that are plain HTTP. The live turn-loop is a WebSocket and
// lives in hooks/useVoiceSession.ts — nothing here touches a session.

/**
 * A short WAV clip of the agent's preview line spoken in `voiceId`, so the
 * settings picker can be auditioned without starting a session.
 *
 * `responseType: 'arraybuffer'` is required: the shared axios instance is
 * JSON-by-default, and letting it decode audio bytes as UTF-8 corrupts the clip.
 * The gateway proxies this to ai_service (which owns the Cartesia key and caches
 * one render per voice), so the browser never sees a vendor credential.
 *
 * Rejects with a message fit to show the user — see `readErrorBody`.
 */
export async function fetchVoicePreview(voiceId: string): Promise<Blob> {
  try {
    const { data, headers } = await api.post<ArrayBuffer>(
      '/voice/preview',
      { voice_id: voiceId },
      { responseType: 'arraybuffer' },
    )
    // Axios types a response header as string | number | boolean | string[] |
    // AxiosHeaders, so narrow before handing it to Blob's `type`.
    const contentType = headers['content-type']
    return new Blob([data], {
      type: typeof contentType === 'string' ? contentType : 'audio/wav',
    })
  } catch (err) {
    // `cause` keeps the axios error (status, config) reachable for debugging while
    // the message stays something the settings screen can render verbatim.
    throw new Error(readErrorBody(err), { cause: err })
  }
}

// `responseType: 'arraybuffer'` applies to error responses too, so the gateway's
// `{ error: "..." }` arrives as bytes rather than a parsed object — decode it, or
// every failure would read as a generic "Request failed with status code 503".
function readErrorBody(err: unknown): string {
  const fallback = 'Could not play a preview. Please try again.'
  if (!axios.isAxiosError(err)) return fallback
  const body = err.response?.data
  if (body instanceof ArrayBuffer && body.byteLength > 0) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body)) as { error?: string }
      if (parsed.error) return parsed.error
    } catch {
      /* not JSON — fall through to the generic message */
    }
  }
  return fallback
}
