import { translate, type TranslationKey } from '../../../i18n/index.js'
import type { UploadUnavailableReason } from '../../../services/remote/upload.js'

/**
 * 上传失败原因的**文案映射**（R15）。
 *
 * 数据层（`services/remote/upload.ts`）给的是稳定原因码 + 中文兜底串；这里把码翻成
 * i18n 键，界面（按钮 tooltip、附件条）只认这里，别在组件里写中文。
 */

const REASON_KEYS: Record<UploadUnavailableReason, TranslationKey> = {
  'both-unavailable': 'uploadReasonBothUnavailable',
  'receipt-unavailable': 'uploadReasonReceiptUnavailable',
  'workspace-unavailable': 'uploadReasonWorkspaceUnavailable',
  'workspace-capability-missing': 'uploadReasonCapabilityMissing',
  'too-large': 'uploadReasonTooLarge',
}

/** 原因码 → i18n 原文；码不认识就退回数据层那句话（`fallback`）。 */
export const uploadReasonText = (reason: UploadUnavailableReason | null, fallback: string | null): string => {
  if (reason !== null) return translate(REASON_KEYS[reason])
  return fallback ?? translate('uploadReasonBothUnavailable')
}

/** 原因码 → i18n 键（组件里要包一层带 params 的文案时用）。 */
export const uploadReasonKey = (reason: UploadUnavailableReason | null): TranslationKey | null =>
  reason === null ? null : REASON_KEYS[reason]
