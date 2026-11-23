export interface WorkspacePreferences {
  groups: Readonly<Record<string, string>>
  pinned: readonly string[]
  recentDirectories: readonly string[]
}

export const emptyWorkspacePreferences: WorkspacePreferences = {
  groups: {}, pinned: [], recentDirectories: [],
}

const storageKey = (owner: string) => `dsp.remote.workspace-preferences.v1:${owner}`

export function readWorkspacePreferences(owner: string | null): WorkspacePreferences {
  if (owner === null) return emptyWorkspacePreferences
  try {
    const data = JSON.parse(localStorage.getItem(storageKey(owner)) ?? 'null')
    if (data === null || typeof data !== 'object') return emptyWorkspacePreferences
    const strings = (value: unknown, limit: number): string[] => Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, limit)
      : []
    const groups = Object.fromEntries(Object.entries(data.groups ?? {}).filter((pair): pair is [string, string] =>
      typeof pair[1] === 'string' && pair[1].length > 0 && pair[1].length <= 80))
    return { groups, pinned: strings(data.pinned, 200), recentDirectories: strings(data.recentDirectories, 8) }
  } catch {
    return emptyWorkspacePreferences
  }
}

export function writeWorkspacePreferences(owner: string | null, preferences: WorkspacePreferences) {
  if (owner === null) return
  try {
    localStorage.setItem(storageKey(owner), JSON.stringify(preferences))
  } catch {
    // The live store still holds the preferences for this connection.
  }
}

export type WorkspaceSection<Item> = {
  kind: 'pinned' | 'group' | 'remaining'
  name?: string
  items: Item[]
}

export function workspaceSections<Item extends { workspaceId: string }>(
  items: readonly Item[], preferences: WorkspacePreferences,
): WorkspaceSection<Item>[] {
  const byId = new Map(items.map((item) => [item.workspaceId, item]))
  const pinned = preferences.pinned.flatMap((id) => {
    const item = byId.get(id)
    byId.delete(id)
    return item === undefined ? [] : [item]
  })
  const groups = new Map<string, Item[]>()
  const remaining: Item[] = []
  for (const item of byId.values()) {
    const name = Object.hasOwn(preferences.groups, item.workspaceId) ? preferences.groups[item.workspaceId] : undefined
    if (name === undefined) remaining.push(item)
    else {
      const group = groups.get(name)
      if (group === undefined) groups.set(name, [item])
      else group.push(item)
    }
  }
  const sections: WorkspaceSection<Item>[] = []
  if (pinned.length) sections.push({ kind: 'pinned', items: pinned })
  for (const [name, items] of groups) sections.push({ kind: 'group', name, items })
  if (remaining.length) sections.push({ kind: 'remaining', items: remaining })
  return sections
}
