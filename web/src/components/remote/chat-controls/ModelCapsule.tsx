import { useCallback, useState } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import { modelDisplayName, useChatControls } from '../../../services/remote/sessionControls.js'
import { IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14 } from '../../base/icons.js'
import styles from './Controls.module.css'
import { Popover } from './Popover.js'

/**
 * 顶栏右侧的**模型胶囊**：点开列 `session/modelCatalog` 的分组，选中即 `session/selectModel`。
 *
 * 三个必须照做的地方（都来自上游 `pickers.tsx:402-515` 的 `ModelPicker`）：
 *  1. **按 provider 分组**展示（`groups[].name` + `models[].name`），不是一张平表；
 *  2. 当前模型打勾，再点一次当前模型是**空操作**（不重复发 `selectModel`）；
 *  3. 当前模型如果声明了 `reasoning.efforts`，给一行「思考强度」进二级选择
 *     （`selectModel` 的 `reasoningEffort` 字段）。
 *
 * 能力门禁：`modelAccess === 'unavailable'` 时整个胶囊不渲染（`SessionControlsBar` 里判的），
 * 拉取失败只写 store 的 `error`，不在这里弹东西。
 */
export const ModelCapsule = () => {
  const t = useTranslate()
  const catalog = useChatControls((state) => state.modelCatalog)
  const current = useChatControls((state) => state.currentModel)
  const loading = useChatControls((state) => state.loadingModel)
  const selectModel = useChatControls((state) => state.selectModel)
  const loadModelCatalog = useChatControls((state) => state.loadModelCatalog)
  const [effortView, setEffortView] = useState(false)

  const currentGroup = catalog?.groups.find((group) => group.id === current?.provider)
  const currentModel = currentGroup?.models.find((model) => model.id === current?.model)
  const efforts = currentModel?.efforts ?? []
  const activeEffortId = current?.reasoningEffort ?? currentModel?.defaultEffort
  const activeEffort = efforts.find((effort) => effort.id === activeEffortId)
  const label = modelDisplayName(catalog, current) ?? t('chatControlsModelDefault')

  const pick = useCallback(
    (provider: string, model: string, reasoningEffort?: string, close?: () => void) => {
      void selectModel({
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      close?.()
    },
    [selectModel],
  )

  return (
    <Popover
      label={t('chatControlsModel')}
      align="end"
      width={300}
      maxHeight={460}
      onOpenChange={(open) => {
        if (!open) {
          setEffortView(false)
          return
        }
        // 每次打开都问一次 Host：别的设备可能刚换过模型，缓存不刷新会显示旧名字
        void loadModelCatalog(true)
      }}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={open ? `${styles.pill} ${styles.pillActive}` : styles.pill}
          aria-label={t('chatControlsModelAria', { name: label })}
          aria-expanded={open}
          onClick={toggle}
        >
          <span className={styles.pillText}>{label}</span>
          <span className={styles.pillChevron} aria-hidden>
            <IconChevronDownOutline14 />
          </span>
        </button>
      )}
    >
      {({ close }) => (
        <>
          <div className={styles.panelHead}>
            {effortView ? (
              <button
                type="button"
                className={styles.iconPill}
                aria-label={t('chatControlsBack')}
                onClick={() => setEffortView(false)}
              >
                <span aria-hidden>←</span>
              </button>
            ) : null}
            <span className={styles.panelTitle}>
              {t(effortView ? 'chatControlsModelEffort' : 'chatControlsSelectModel')}
            </span>
          </div>
          <div className={styles.panelBody}>
            {loading && catalog === null ? <div className={styles.empty}>{t('chatControlsModelLoading')}</div> : null}
            {catalog !== null && catalog.groups.length === 0 ? (
              <div className={styles.empty}>{t('chatControlsModelEmpty')}</div>
            ) : null}
            {effortView
              ? efforts.map((effort) => {
                  const selected = activeEffortId === effort.id
                  return (
                    <button
                      key={effort.id}
                      type="button"
                      className={selected ? `${styles.row} ${styles.rowActive}` : styles.row}
                      aria-pressed={selected}
                      onClick={() => {
                        if (current === null) return
                        pick(current.provider, current.model, effort.id, close)
                      }}
                    >
                      <span className={styles.rowCopy}>
                        <span className={styles.rowName}>{effort.name}</span>
                        {effort.description === undefined ? null : (
                          <span className={styles.rowHint}>{effort.description}</span>
                        )}
                      </span>
                      {selected ? (
                        <span className={styles.rowCheck} aria-hidden>
                          <IconCheckOutline16 />
                        </span>
                      ) : null}
                    </button>
                  )
                })
              : (catalog?.groups ?? []).map((group) => (
                  <div key={group.id}>
                    <div className={styles.sectionTitle}>{group.name}</div>
                    {group.models.map((model) => {
                      const selected = current?.provider === group.id && current.model === model.id
                      return (
                        <button
                          key={model.id}
                          type="button"
                          className={selected ? `${styles.row} ${styles.rowActive}` : styles.row}
                          aria-pressed={selected}
                          onClick={() => {
                            if (selected) {
                              close()
                              return
                            }
                            pick(group.id, model.id, undefined, close)
                          }}
                        >
                          <span className={styles.rowCopy}>
                            <span className={styles.rowName}>{model.name}</span>
                            {model.description === undefined ? null : (
                              <span className={styles.rowHint}>{model.description}</span>
                            )}
                          </span>
                          {selected ? (
                            <span className={styles.rowCheck} aria-hidden>
                              <IconCheckOutline16 />
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                ))}
          </div>
          {effortView || efforts.length === 0 ? null : (
            <>
              <div className={styles.divider} />
              <button type="button" className={styles.row} onClick={() => setEffortView(true)}>
                <span className={styles.rowName}>{t('chatControlsModelEffort')}</span>
                <span className={styles.rowTail}>
                  {activeEffort?.name ?? t('chatControlsModelEffortDefault')}
                </span>
                <span className={styles.pillChevron} aria-hidden>
                  <IconChevronRightOutline14 />
                </span>
              </button>
            </>
          )}
          {catalog !== null && catalog.failures.length > 0 ? (
            <div className={styles.hint}>
              {t('chatControlsModelFailures', {
                text: catalog.failures.map((failure) => failure.message).join('; '),
              })}
            </div>
          ) : null}
        </>
      )}
    </Popover>
  )
}
