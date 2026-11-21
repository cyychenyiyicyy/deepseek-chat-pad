import { useCallback, useState } from 'react'
import { useTheme } from '../../../app/theme.js'
import { useTranslate } from '../../../i18n/index.js'
import { effortPalette } from '../../../services/models/effortPalette.js'
import {
  modelDisplayName,
  useChatControls,
  type RemoteModelSelection,
} from '../../../services/remote/sessionControls.js'
import { IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14 } from '../../base/icons.js'
import {
  activeEffortIdOf,
  effortLevelsOf,
  effortNameOf,
  modelPillText,
  showsEffortSlider,
} from '../composer/effortLevels.js'
import { EffortEnds, EffortSlider } from '../composer/EffortSlider.js'
import styles from './Controls.module.css'
import { Popover } from './Popover.js'

type PanelView = 'effort' | 'model'

/**
 * 输入框里的**模型胶囊**：`模型名 · 思考档位`，点开是「模型 + 思考强度」一体的面板。
 *
 * 这一版是从「顶栏模型胶囊 + 二级思考强度列表」**改造**来的（不是重写）：
 *
 *  - 数据与动作没变：仍是 `session/modelCatalog` + `session/selectModel`
 *    （`reasoningEffort` 字段随模型一起提交，见 `sessionControls.selectModel`）；
 *  - 触发器的形状没变：还是 `Popover` + `styles.pill`；
 *  - 变的是**思考强度从「一列单选行」换成滑条**（`composer/EffortSlider`，与本机聊天
 *    那个 `components/models/ModelCapsule` 同一套刻度 / 磁吸 / 配色 —— 用户说的
 *    「用之前做好的模型选择器」指的就是它）。
 *
 * 三个必须照做的地方（都来自上游 `pickers.tsx:402-515` 的 `ModelPicker`）：
 *  1. **按 provider 分组**展示（`groups[].name` + `models[].name`），不是一张平表；
 *  2. 当前模型打勾，再点一次当前模型是**空操作**（不重复发 `selectModel`）；
 *  3. 换模型时**不携带**旧模型的 `reasoningEffort`（Host 会回到该模型的 `defaultEffort`）。
 *
 * 能力门禁：`modelAccess === 'unavailable'` 时整个胶囊不渲染（`showsModelCapsule` 判的），
 * 拉取失败只写 store 的 `error`，不在这里弹东西。
 */
export const ModelCapsule = () => {
  const t = useTranslate()
  const theme = useTheme()
  const catalog = useChatControls((state) => state.modelCatalog)
  const current = useChatControls((state) => state.currentModel)
  const loading = useChatControls((state) => state.loadingModel)
  const selectModel = useChatControls((state) => state.selectModel)
  const loadModelCatalog = useChatControls((state) => state.loadModelCatalog)
  const [view, setView] = useState<PanelView>('effort')

  const levels = effortLevelsOf(catalog, current)
  const activeId = activeEffortIdOf(catalog, current)
  const activeName = effortNameOf(levels, activeId)
  const pill = modelPillText(catalog, current)
  const palette = effortPalette(activeId ?? 'off', theme === 'dark')
  const label = modelDisplayName(catalog, current) ?? t('chatControlsModelDefault')
  const canSlide = showsEffortSlider(levels)

  const pick = useCallback(
    (provider: string, model: string, reasoningEffort?: string): void => {
      const selection: RemoteModelSelection = {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      }
      void selectModel(selection)
    },
    [selectModel],
  )

  /** 拖动 / 点刻度 / 键盘：只改档位，模型不动（面板不关，方便连着试几档） */
  const pickEffort = useCallback(
    (effortId: string): void => {
      if (current === null) return
      pick(current.provider, current.model, effortId)
    },
    [current, pick],
  )

  return (
    <Popover
      label={t('composerModelAria', { name: label })}
      align="start"
      width={300}
      maxHeight={460}
      onOpenChange={(open) => {
        if (!open) {
          setView('effort')
          return
        }
        // 每次打开都问一次 Host：别的设备可能刚换过模型，缓存不刷新会显示旧名字
        void loadModelCatalog(true)
      }}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={open ? `${styles.pill} ${styles.pillActive}` : styles.pill}
          aria-label={t('composerModelAria', { name: label })}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={toggle}
        >
          <span className={styles.pillText}>{pill.name}</span>
          {/* 折叠规则：这个模型没声明档位时，第二段整段不渲染（不留破折号、不占位） */}
          {pill.effortName === null ? null : (
            <span className={styles.pillEffort} style={{ color: palette.ink }}>
              {pill.effortName}
            </span>
          )}
          <span className={styles.pillChevron} aria-hidden>
            <IconChevronDownOutline14 />
          </span>
        </button>
      )}
    >
      {({ close }) => (
        <>
          {view === 'effort' ? (
            <>
              <div className={styles.panelHead}>
                <button
                  type="button"
                  className={styles.effortHead}
                  onClick={() => setView('model')}
                  aria-label={t('composerModelSwitch')}
                >
                  <span className={styles.panelTitle} style={{ color: palette.ink }}>
                    {activeName ?? t('composerEffortDefault')}
                  </span>
                  <span className={styles.panelTail}>
                    {pill.name}
                    <IconChevronRightOutline14 />
                  </span>
                </button>
              </div>
              <div className={styles.effortPanel}>
                {canSlide ? (
                  <>
                    <EffortSlider
                      levels={levels}
                      value={activeId}
                      onPick={pickEffort}
                      label={t('chatControlsModelEffort')}
                    />
                    <EffortEnds levels={levels} />
                  </>
                ) : (
                  <div className={styles.empty}>
                    {loading && catalog === null ? t('chatControlsModelLoading') : t('composerEffortNone')}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className={styles.panelHead}>
                <button
                  type="button"
                  className={styles.iconPill}
                  aria-label={t('chatControlsBack')}
                  onClick={() => setView('effort')}
                >
                  <span aria-hidden>←</span>
                </button>
                <span className={styles.panelTitle}>{t('chatControlsSelectModel')}</span>
              </div>
              <div className={styles.panelBody}>
                {loading && catalog === null ? <div className={styles.empty}>{t('chatControlsModelLoading')}</div> : null}
                {catalog !== null && catalog.groups.length === 0 ? (
                  <div className={styles.empty}>{t('chatControlsModelEmpty')}</div>
                ) : null}
                {(catalog?.groups ?? []).map((group) => (
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
                              setView('effort')
                              return
                            }
                            // 换模型不带旧档位：Host 用新模型的 defaultEffort
                            pick(group.id, model.id)
                            setView('effort')
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
              {catalog !== null && catalog.failures.length > 0 ? (
                <div className={styles.hint}>
                  {t('chatControlsModelFailures', {
                    text: catalog.failures.map((failure) => failure.message).join('; '),
                  })}
                </div>
              ) : null}
            </>
          )}
          {view === 'model' && canSlide ? (
            <div className={styles.hint}>{t('composerModelSwitchHint')}</div>
          ) : null}
          {view === 'effort' && canSlide ? (
            <button type="button" className={styles.closeRow} onClick={close}>
              {t('composerModelDone')}
            </button>
          ) : null}
        </>
      )}
    </Popover>
  )
}
