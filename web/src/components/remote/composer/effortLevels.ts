/**
 * 输入区模型胶囊的**纯逻辑**：把 `session/modelCatalog` 读成「模型名 + 思考档位 + 滑条几何」。
 *
 * 与 `components/models/ModelCapsule.tsx`（本机聊天的那个选择器）保持同一套手感：
 * 同一组档位刻度、同一份磁吸配方（`MAGNET_RATIO`）、同一份配色（`services/models/effortPalette`）。
 * 差别只在**数据从哪来**：本机读 `settings.thinkingEffort` + 模型目录，
 * 远程读 Host 的 `session/modelCatalog.groups[].models[].reasoning.efforts`，
 * 选中后走 `session/selectModel` 的 `reasoningEffort` 字段（`sessionControls.selectModel`）。
 *
 * 为什么不复用 `services/models/*` 的 `buildEffortLevels`：那个函数吃的是「模型元数据里
 * 声明了哪些推理档」加上本地设置的当前值，而远程的档位是 **Host 逐模型给的 `{id,name}[]`**
 * （还带 `defaultEffort`）；语义对不上，硬套会把「Host 默认」错翻成「参数默认」。
 *
 * 本文件只有类型 import + 纯函数：自测在 node 里直接跑，不拉 zustand / DOM。
 */

import type {
  RemoteModelCatalog,
  RemoteModelEffort,
  RemoteModelSelection,
} from '../../../services/remote/sessionControls.js'

/** 磁吸范围：档距的 18%（与 `components/models/ModelCapsule.tsx` 同值） */
export const MAGNET_RATIO = 0.18

export interface ModelHit {
  groupId: string
  groupName: string
  model: { id: string; name: string; efforts: RemoteModelEffort[]; defaultEffort?: string }
}

/** 在当前目录里找到「当前选中」的那一行（找不到 = 目录还没到 / Host 换了模型）。 */
export const findSelection = (
  catalog: RemoteModelCatalog | null,
  selection: RemoteModelSelection | null,
): ModelHit | null => {
  if (catalog === null || selection === null) return null
  const group = catalog.groups.find((item) => item.id === selection.provider)
  if (group === undefined) return null
  const model = group.models.find((item) => item.id === selection.model)
  if (model === undefined) return null
  return { groupId: group.id, groupName: group.name, model }
}

/** 当前模型声明的档位（顺序即 Host 给的顺序：从低到高）。 */
export const effortLevelsOf = (
  catalog: RemoteModelCatalog | null,
  selection: RemoteModelSelection | null,
): RemoteModelEffort[] => findSelection(catalog, selection)?.model.efforts ?? []

/**
 * 当前档位 id：**投影/选择里的值优先，其次模型的 `defaultEffort`**。
 *
 * 「投影优先」很重要：别的设备刚改过档位时，`session/control` 的投影才是权威。
 */
export const activeEffortIdOf = (
  catalog: RemoteModelCatalog | null,
  selection: RemoteModelSelection | null,
): string | undefined => {
  const hit = findSelection(catalog, selection)
  if (selection?.reasoningEffort !== undefined && selection.reasoningEffort.length > 0) {
    return selection.reasoningEffort
  }
  return hit?.model.defaultEffort
}

/** 档位名（胶囊收起态显示这个）；找不到给 `null`。 */
export const effortNameOf = (
  levels: readonly RemoteModelEffort[],
  value: string | undefined,
): string | null => {
  if (value === undefined) return null
  return levels.find((item) => item.id === value)?.name ?? null
}

/** 档位在列表里的下标；解析不出来给 `-1`（滑条停在起点、填充为空）。 */
export const effortIndex = (
  levels: readonly RemoteModelEffort[],
  value: string | undefined,
): number => {
  if (value === undefined || levels.length === 0) return -1
  return levels.findIndex((item) => item.id === value)
}

/** 下标 → 0..1 的滑条位置；`count < 2` 时恒为 0（不会出现 0/0 = NaN）。 */
export const effortRatioOf = (index: number, count: number): number => {
  if (count < 2) return 0
  if (index < 0) return 0
  return Math.min(count - 1, index) / (count - 1)
}

/** 0..1 → 最近的档位下标（夹在两端，`count < 2` 恒为 0）。 */
export const ratioToIndex = (ratio: number, count: number): number => {
  if (count < 1) return 0
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0
  return Math.min(count - 1, Math.max(0, Math.round(clamped * (count - 1))))
}

/**
 * 磁吸：离档位够近时把指针位置往档位拉（拖动过程中就有吸附感），松手才真正吸附。
 * 与 `components/models/ModelCapsule.tsx` 的 `magnetize()` 同一套公式。
 */
export const magnetizeRatio = (
  raw: number,
  count: number,
  magnetRatio: number = MAGNET_RATIO,
): number => {
  if (count < 2) return raw
  const steps = count - 1
  const nearest = Math.round(raw * steps) / steps
  const distance = Math.abs(raw - nearest)
  const threshold = magnetRatio / steps
  if (distance >= threshold) return raw
  const pull = 1 - distance / threshold
  return raw + (nearest - raw) * pull
}

/** 有没有可拖的档位：单档 / 没有档位时不画滑条（画了也没得选）。 */
export const showsEffortSlider = (levels: readonly RemoteModelEffort[]): boolean => levels.length > 1

export interface ModelPillText {
  /** 胶囊上第一段：模型显示名（目录里没有就回落成 model id） */
  name: string
  /** 胶囊上第二段：档位 id（配色用）；`null` = 这个模型没有档位 */
  effortId: string | null
  /** 胶囊上第二段：档位显示名；`null` = 这个模型没有档位 */
  effortName: string | null
}

/**
 * 收起态胶囊要显示的东西：`模型名 · 档位`。
 *
 * 折叠规则（用户说的「胶囊折叠」）：**模型没声明档位时第二段整段不渲染**，
 * 胶囊不会留下一个空档 / 一个破折号；目录还没到的时候也一样，只显示模型 id。
 */
export const modelPillText = (
  catalog: RemoteModelCatalog | null,
  selection: RemoteModelSelection | null,
): ModelPillText => {
  if (selection === null) return { name: '', effortId: null, effortName: null }
  const hit = findSelection(catalog, selection)
  const levels = hit?.model.efforts ?? []
  const effortId = activeEffortIdOf(catalog, selection) ?? null
  const effortName = showsEffortSlider(levels) ? effortNameOf(levels, effortId ?? undefined) : null
  return {
    name: hit?.model.name ?? selection.model,
    effortId: effortName === null ? null : effortId,
    effortName,
  }
}
