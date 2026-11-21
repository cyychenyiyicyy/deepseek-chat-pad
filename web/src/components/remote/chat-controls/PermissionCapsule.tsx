import { useCallback } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import { permissionDisplayName, useChatControls } from '../../../services/remote/sessionControls.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from '../../base/icons.js'
import styles from './Controls.module.css'
import { Popover } from './Popover.js'

/**
 * 顶栏右侧的**权限预设胶囊**。
 *
 * 选项来自 `permissionPresets/catalog`（`{options:[{value,name,description?}]}`），
 * 但**切换只有一条路**：`commands/execute` 的 `/permission <preset>`（input-B §2.10 明确写了
 * 「Host 侧没有独立的选择端点」，`harness-alpha-client.ts:745-753` 也是这么实现的）。
 * 当前值优先取投影 `permissions.currentValue`（Host 权威），拿不到才回落到本地刚点的那个。
 *
 * 能力门禁：`permissionAccess === 'unavailable'` 时整个胶囊不渲染。
 */
export const PermissionCapsule = () => {
  const t = useTranslate()
  const options = useChatControls((state) => state.permissions)
  const current = useChatControls((state) => state.currentPermission)
  const loading = useChatControls((state) => state.loadingPermission)
  const selectPermission = useChatControls((state) => state.selectPermission)
  const loadPermissions = useChatControls((state) => state.loadPermissions)

  const label = permissionDisplayName(options, current) ?? t('chatControlsPermissionDefault')
  const pick = useCallback(
    (value: string, close: () => void) => {
      close()
      // 点了就关：结果由 Host 的投影回推（失败时错误条会出现在输入区上方）
      void selectPermission(value)
    },
    [selectPermission],
  )

  return (
    <Popover
      label={t('chatControlsPermission')}
      align="end"
      width={300}
      maxHeight={420}
      onOpenChange={(open) => {
        if (open) void loadPermissions(true)
      }}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={open ? `${styles.pill} ${styles.pillActive}` : styles.pill}
          aria-label={t('chatControlsPermissionAria', { name: label })}
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
            <span className={styles.panelTitle}>{t('chatControlsSelectPermission')}</span>
          </div>
          <div className={styles.panelBody}>
            {loading && options.length === 0 ? (
              <div className={styles.empty}>{t('chatControlsPermissionLoading')}</div>
            ) : null}
            {!loading && options.length === 0 ? (
              <div className={styles.empty}>{t('chatControlsPermissionEmpty')}</div>
            ) : null}
            {options.map((option) => {
              const selected = option.value === current
              return (
                <button
                  key={option.value}
                  type="button"
                  className={selected ? `${styles.row} ${styles.rowActive}` : styles.row}
                  aria-pressed={selected}
                  onClick={() => pick(option.value, close)}
                >
                  <span className={styles.rowCopy}>
                    <span className={styles.rowName}>{option.name}</span>
                    {option.description === undefined ? null : (
                      <span className={styles.rowHint}>{option.description}</span>
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
          <div className={styles.hint}>{t('chatControlsPermissionHint')}</div>
        </>
      )}
    </Popover>
  )
}
