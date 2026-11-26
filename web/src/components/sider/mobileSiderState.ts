import { create } from 'zustand'

/** 单栏窗口里的会话列表由主导航开启，选中或新建会话后返回聊天。 */
export const useMobileSider = create(() => ({ open: false }))

export const openMobileSider = () => useMobileSider.setState({ open: true })

export const closeMobileSider = () => useMobileSider.setState({ open: false })
