import { decodeBase64, fileKindOf, normalizeRelativePath, readWorkspaceBytesRange, statWorkspaceFile } from './filesApi.js'
import { RemoteApiError } from './serverApi.js'
import { callEndpoint, type RemoteCallTarget } from './sessionsApi.js'

const PDF_LIMIT = 16 * 1024 * 1024
const OFFICE_SOURCE_LIMIT = 50 * 1024 * 1024
const RENDER_TIMEOUT_MS = 120_000

export async function workspaceDocumentPreview(
  target: RemoteCallTarget, sessionId: string, path: string, signal: AbortSignal,
): Promise<{ bytes: Uint8Array; missingFonts: string[] }> {
  const normalized = normalizeRelativePath(path)
  const kind = fileKindOf(normalized)
  if (kind !== 'pdf' && kind !== 'office') throw new RemoteApiError('FEATURE_NOT_SUPPORTED', 'Unsupported document type.')
  const before = await statWorkspaceFile(target, sessionId, normalized)
  signal.throwIfAborted()
  if (!before.version || !before.absolutePath) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not identify this document version.')
  }
  if (before.bytes !== undefined && before.bytes > (kind === 'pdf' ? PDF_LIMIT : OFFICE_SOURCE_LIMIT)) {
    throw new RemoteApiError('FRAME_TOO_LARGE', 'The document exceeds the preview size limit.')
  }
  let bytes: Uint8Array
  let missingFonts: string[] = []
  if (kind === 'pdf') {
    const range = await readWorkspaceBytesRange(target, sessionId, normalized, 0, PDF_LIMIT, {
      expectedVersion: before.version, signal,
    })
    signal.throwIfAborted()
    if (!range.eof || (before.bytes !== undefined && range.data.byteLength !== before.bytes)) {
      throw new RemoteApiError('INVALID_MESSAGE', 'The PDF preview is incomplete.')
    }
    bytes = range.data
  } else {
    const generation = await callEndpoint<unknown>(target, 'officeToPdf/generation', {}, RENDER_TIMEOUT_MS)
    signal.throwIfAborted()
    if (typeof generation !== 'string' || generation.length === 0) throw invalidPdf()
    const pdf = await callEndpoint<Record<string, unknown>>(target, 'officeToPdf/render', {
      workspaceFileScopeId: sessionId, path: normalized, priority: 'foreground',
    }, RENDER_TIMEOUT_MS)
    signal.throwIfAborted()
    if (!pdf || pdf.generation !== generation || pdf.version !== before.version || pdf.absolutePath !== before.absolutePath ||
      pdf.offset !== 0 || pdf.eof !== true || typeof pdf.data !== 'string' || pdf.data.length > 4 * Math.ceil(PDF_LIMIT / 3)) {
      throw invalidPdf()
    }
    bytes = decodeBase64(pdf.data)
    if (pdf.bytes !== bytes.byteLength) throw invalidPdf()
    if (Array.isArray(pdf.missingFonts)) {
      missingFonts = pdf.missingFonts.slice(0, 32).flatMap((font: unknown) =>
        typeof font === 'string' && font.trim() ? [font.trim().slice(0, 256)] : [])
    }
  }
  const after = await statWorkspaceFile(target, sessionId, normalized)
  signal.throwIfAborted()
  if (after.version !== before.version || after.absolutePath !== before.absolutePath || after.bytes !== before.bytes) {
    throw new RemoteApiError('WORKSPACE_FILE_CHANGED', 'The workspace file changed during the preview.')
  }
  const ascii = new TextDecoder()
  if (bytes.byteLength > PDF_LIMIT || ascii.decode(bytes.subarray(0, 5)) !== '%PDF-' ||
    !ascii.decode(bytes.subarray(-2048)).includes('%%EOF')) throw invalidPdf()
  return { bytes, missingFonts }
}

function invalidPdf() {
  return new RemoteApiError('INVALID_MESSAGE', 'The Host returned an invalid PDF preview.')
}
