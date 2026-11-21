/**
 * [S3] 截图构建配置：复用主配置的 loader / CSS Modules 处理，只换入口与产物目录。
 *
 * 产物落在 `tmp-shot/dist`（不进 `dist`，也不影响正式构建）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack } from '@rspack/core'
import { createConfig } from '../rspack.config.ts'

const root = path.dirname(fileURLToPath(import.meta.url))
const base = createConfig()

export default defineConfig({
  ...base,
  mode: 'production',
  devtool: false,
  entry: path.resolve(root, 'entry.tsx'),
  output: {
    ...base.output,
    path: path.resolve(root, 'dist'),
    clean: true,
    publicPath: 'auto',
    filename: 'shot.js',
    chunkFilename: 'shot-[name].js',
    cssFilename: 'shot.css',
    cssChunkFilename: 'shot-[name].css',
    assetModuleFilename: 'media/[name][ext]',
  },
  plugins: [
    new rspack.HtmlRspackPlugin({
      template: path.resolve(root, 'shot.html'),
      scriptLoading: 'defer',
      filename: 'index.html',
    }),
  ],
  stats: 'errors-warnings',
})
