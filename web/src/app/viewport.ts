import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react'

/** 窄屏和低高度横屏共用可收起的导航。 */
const query = window.matchMedia('(max-width: 767px), (max-height: 500px)')

const subscribe = (onChange: () => void) => {
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export const useIsMobile = () => useSyncExternalStore(subscribe, () => query.matches)

/**
 * 主指针是否为触摸（平板 / 手机）。
 * 这类设备上不应自动聚焦输入框——一聚焦就会弹出软键盘，而用户往往还没准备输入。
 * 桌面浏览器（鼠标）不受影响，仍保留自动聚焦。
 */
const coarseQuery = window.matchMedia('(pointer: coarse)')

const subscribeCoarse = (onChange: () => void) => {
  coarseQuery.addEventListener('change', onChange)
  return () => coarseQuery.removeEventListener('change', onChange)
}

export const useIsTouchPrimary = () =>
  useSyncExternalStore(subscribeCoarse, () => coarseQuery.matches)

const preventPageScroll = (event: TouchEvent) => {
  if (event.touches.length !== 1) {
    return
  }
  for (
    let element = event.target instanceof Element ? event.target : null;
    element && element !== document.body;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element)
    const scrollsY =
      /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight
    const scrollsX =
      /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth
    if (scrollsY || scrollsX) {
      return
    }
  }
  event.preventDefault()
}

/** 阻止移动端整页滚动，保留内部可滚动区域的滚动和双指缩放。 */
export const usePreventPageScroll = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    document.addEventListener('touchmove', preventPageScroll, { passive: false })
    return () => document.removeEventListener('touchmove', preventPageScroll)
  }, [enabled])
}

/** 聊天与浮层共同跟随视觉视口，包括平板横屏的软键盘。 */
export const useMobileViewport = (uiScale: number) => {
  useLayoutEffect(() => {
    const { style } = document.documentElement
    const viewport = window.visualViewport
    const inputTypes = ['email', 'number', 'password', 'search', 'tel', 'text', 'url']
    const hasKeyboardInput = () => {
      const field = document.activeElement
      return (
        (field instanceof HTMLTextAreaElement && !field.readOnly) ||
        (field instanceof HTMLInputElement && !field.readOnly && inputTypes.includes(field.type))
      )
    }
    let animationFrame = 0
    const reset = () => {
      style.removeProperty('--app-viewport-height')
      style.removeProperty('--app-viewport-top')
    }
    const update = () => {
      // 双指缩放由浏览器处理，保持当前布局尺寸。
      if (viewport && viewport.scale !== 1) {
        return
      }
      // 失焦后直接恢复 CSS 的全高布局，不等 Safari 收键盘后的 resize。
      if (!hasKeyboardInput()) {
        reset()
        return
      }
      style.setProperty(
        '--app-viewport-height',
        `${(viewport?.height ?? window.innerHeight) / uiScale}px`
      )
      style.setProperty('--app-viewport-top', `${(viewport?.offsetTop ?? 0) / uiScale}px`)
    }
    const scheduleFrame = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(update)
    }
    const schedule = () => {
      // 先同步跟上键盘动画，下一帧再校准 Safari 延迟更新的视口读数。
      update()
      scheduleFrame()
    }
    const onFocusIn = () => {
      if (hasKeyboardInput()) {
        schedule()
      }
    }

    update()
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    document.addEventListener('focusin', onFocusIn)
    // 等点击和焦点切换完成，避免按钮移动、或切换输入框时短暂恢复全高。
    document.addEventListener('focusout', scheduleFrame)
    return () => {
      cancelAnimationFrame(animationFrame)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', scheduleFrame)
      reset()
    }
  }, [uiScale])
}
