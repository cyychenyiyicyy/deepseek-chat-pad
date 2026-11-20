import { create } from 'zustand'
import type { MigrationProgress } from './dbNative.js'

export type MigrationPhase = 'idle' | MigrationProgress['phase'] | 'done' | 'failed'

type MigrationState = {
  phase: MigrationPhase
  done: number
  total: number
  visible: boolean
}

/**
 * 迁移进度全局状态。
 *
 * 迁移发生在第一次读写存储时，会话多的用户要等几秒 —— 没有进度就是「应用卡住了」，
 * 所以这段必须显式告诉用户在干什么、还剩多少。
 */
export const useMigration = create<MigrationState>(() => ({
  phase: 'idle',
  done: 0,
  total: 0,
  visible: false,
}))

export const migrationStart = () =>
  useMigration.setState({ phase: 'prepare', done: 0, total: 0, visible: true })

export const migrationProgress = (progress: MigrationProgress) =>
  useMigration.setState({
    phase: progress.phase,
    done: progress.done,
    total: progress.total,
    visible: true,
  })

export const migrationEnd = (ok: boolean) =>
  useMigration.setState({ phase: ok ? 'done' : 'failed', visible: true })

export const migrationDismiss = () =>
  useMigration.setState({ phase: 'idle', done: 0, total: 0, visible: false })
