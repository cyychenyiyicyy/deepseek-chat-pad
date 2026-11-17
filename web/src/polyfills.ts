/**
 * 老 WebView 的 API 补齐。
 *
 * 上游代码用了一些较新的内置方法，而国内平板 / 老安卓 9 设备的系统 WebView 常年停在
 * 74–110 之间。缺一个方法就会在运行期抛 TypeError，且异常会被上层吞掉、表现成
 * 「发不出消息 / 上传失败」这类看不懂的提示——`toReversed` 就踩过这个坑。
 *
 * 这里只补项目实际用到、以及顺手能安全补齐的少数几个，全部按「缺失才定义」处理，
 * 不影响新设备上的原生实现。
 */

type AnyArray = unknown[]

const define = (target: object, name: string, value: unknown) => {
  if (typeof (target as Record<string, unknown>)[name] === 'function') return
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  })
}

const installArray = () => {
  if (typeof Array.prototype === 'undefined') return
  const proto = Array.prototype as unknown as Record<string, unknown>

  // Chrome 92
  define(proto, 'at', function at(this: AnyArray, index: number) {
    const length = this.length
    const position = Math.trunc(index) || 0
    const resolved = position < 0 ? length + position : position
    return resolved < 0 || resolved >= length ? undefined : this[resolved]
  })

  // Chrome 97
  define(proto, 'findLast', function findLast(
    this: AnyArray,
    predicate: (value: unknown, index: number, array: AnyArray) => boolean,
    thisArg?: unknown
  ) {
    for (let index = this.length - 1; index >= 0; index -= 1) {
      if (predicate.call(thisArg, this[index], index, this)) return this[index]
    }
    return undefined
  })
  define(proto, 'findLastIndex', function findLastIndex(
    this: AnyArray,
    predicate: (value: unknown, index: number, array: AnyArray) => boolean,
    thisArg?: unknown
  ) {
    for (let index = this.length - 1; index >= 0; index -= 1) {
      if (predicate.call(thisArg, this[index], index, this)) return index
    }
    return -1
  })

  // Chrome 110：原代码里 `getContextRounds(history).toReversed()` 缺了它就直接抛错
  define(proto, 'toReversed', function toReversed(this: AnyArray) {
    const result: unknown[] = []
    for (let index = this.length - 1; index >= 0; index -= 1) {
      result.push(this[index])
    }
    return result
  })
  define(proto, 'toSorted', function toSorted(
    this: AnyArray,
    compare?: (a: unknown, b: unknown) => number
  ) {
    const result = this.slice()
    result.sort(compare as ((a: unknown, b: unknown) => number) | undefined)
    return result
  })
  define(proto, 'toSpliced', function toSpliced(this: AnyArray, start: number, deleteCount?: number) {
    const result = this.slice()
    const extra = Array.prototype.slice.call(arguments, 2)
    const removeCount = deleteCount === undefined ? Math.max(0, result.length - start) : deleteCount
    ;(result.splice as (...args: unknown[]) => unknown[]).apply(result, [start, removeCount, ...extra])
    return result
  })
}

const installString = () => {
  if (typeof String.prototype === 'undefined') return
  const proto = String.prototype as unknown as Record<string, unknown>
  define(proto, 'at', function at(this: string, index: number) {
    const position = Math.trunc(index) || 0
    const resolved = position < 0 ? this.length + position : position
    return resolved < 0 || resolved >= this.length ? undefined : this[resolved]
  })
  define(proto, 'replaceAll', function replaceAll(this: string, search: string, replacement: string) {
    return this.split(search).join(replacement)
  })
}

const installObject = () => {
  // Chrome 93
  if (typeof Object.hasOwn !== 'function') {
    Object.hasOwn = function hasOwn(target: object, key: PropertyKey): boolean {
      return Object.prototype.hasOwnProperty.call(target, key)
    }
  }
}

installArray()
installString()
installObject()

export {}
