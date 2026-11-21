import type { RemoteWorkspace } from '../../../services/remote/sessionsApi.js'
import type { WorkspaceListItem } from './WorkspaceList.js'

/**
 * `RemoteWorkspace[]` → `WorkspaceListItem[]`（两处 UI 共用，避免各写一套判定）。
 *
 * 三个判据都在这里定死：
 *   1. **显示名**：`title` → 路径末段 → `workspaceId`（`mergeWorkspaceInventory` 已经兜过一层，
 *      这里再兜一层是为了「Host 只给了 path」的老数据）；
 *   2. **会话数是否权威**：只有来自 `workspace/follow` baseline 的那一份才算
 *      （`hostWorkspaces` 里的 id；`workspace/create` 建出来的也在里面）。
 *      权威才敢在 0 个会话时写「还没有会话」，否则宁可不显示数字；
 *   3. **是否当前**：调用方给 `currentWorkspaceId`（新建会话页 = 选中的那个；
 *      工作区文件抽屉 = 当前会话所在的工作区）。
 */
export const buildWorkspaceItems = ({
  workspaces,
  hostWorkspaces,
  currentWorkspaceId,
  disabledOf,
  hintOf,
}: {
  workspaces: readonly RemoteWorkspace[]
  /** `workspace/follow` 的权威行（决定会话数可不可信）。 */
  hostWorkspaces: readonly RemoteWorkspace[]
  currentWorkspaceId: string | null
  disabledOf?: (workspace: RemoteWorkspace) => boolean
  hintOf?: (workspace: RemoteWorkspace) => string | undefined
}): WorkspaceListItem[] => {
  const authoritative = new Set(hostWorkspaces.map((workspace) => workspace.workspaceId))
  return workspaces.map((workspace) => {
    const hint = hintOf?.(workspace)
    return {
      workspaceId: workspace.workspaceId,
      title: workspace.title.length > 0
        ? workspace.title
        : workspace.path.length > 0
          ? workspace.path
          : workspace.workspaceId,
      path: workspace.path,
      sessionCount: workspace.sessionIds.length,
      countKnown: authoritative.has(workspace.workspaceId),
      current: workspace.workspaceId === currentWorkspaceId,
      ...(disabledOf === undefined ? {} : { disabled: disabledOf(workspace) }),
      ...(hint === undefined ? {} : { hint }),
    }
  })
}
