
import path from 'node:path'
import { createConfig } from '../../web/rspack.config.ts'

const config = createConfig()
config.entry = path.resolve(import.meta.dirname, 'tablet-qa.tsx')
config.output = { ...config.output, path: path.resolve(import.meta.dirname, '../../tmp/qa-dist') }
config.resolve = { ...config.resolve, modules: [path.resolve(import.meta.dirname, '../../web/node_modules'), 'node_modules'] }
config.plugins = [...(config.plugins ?? []), {
  apply(compiler: { webpack: typeof import('@rspack/core') }) {
    new compiler.webpack.NormalModuleReplacementPlugin(/^\.\/core\/index\.js$/u, (resource) => {
      if (resource.context?.endsWith(path.join('services', 'remote'))) {
        resource.request = path.resolve(import.meta.dirname, 'tablet-test-link.ts')
      }
    }).apply(compiler)
  },
}]
export default config


