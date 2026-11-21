import { useState } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import { artifactExtensionOf, type ArtifactFile } from '../../../services/remote/artifacts.js'
import { FileIcon } from '../../files/FileIcon.js'
import styles from './Artifacts.module.css'
import { useArtifactsUi } from './artifactsUiState.js'
import { openArtifactFile } from './openArtifact.js'

/**
 * 一个交付文件的小 chip：图标 + 文件名 + 目录相对路径。
 *
 * 点它 = 打开工作区抽屉并**直接定位到这份文件的预览**（`openArtifactFile`）。
 * 缺失（刚才点过、Host 说文件已经不在）时 chip 变虚线红边 + 「文件已不存在」，
 * 但**仍然可点**：文件可能被重新生成，让用户能自己再试一次。
 */
export const ArtifactChip = ({ file }: { file: ArtifactFile }) => {
  const t = useTranslate()
  const missing = useArtifactsUi((state) => state.missing[file.path] === true)
  const [busy, setBusy] = useState(false)

  const open = (): void => {
    if (busy) return
    setBusy(true)
    void openArtifactFile(file).finally(() => setBusy(false))
  }

  return (
    <button
      type="button"
      className={styles.chip}
      data-missing={missing}
      data-busy={busy}
      title={missing ? `${file.path} · ${t('artifactsFileMissing')}` : `${file.path} · ${file.toolKey}`}
      onClick={open}
    >
      <span className={styles.chipGlyph} aria-hidden>
        <FileIcon ext={artifactExtensionOf(file.path)} />
      </span>
      <span className={styles.chipName}>{file.name}</span>
      {file.dir.length === 0 ? null : <span className={styles.chipDir}>{file.dir}</span>}
      {missing ? <span className={styles.chipMissing}>{t('artifactsFileMissing')}</span> : null}
    </button>
  )
}
