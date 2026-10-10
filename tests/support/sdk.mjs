import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const sdkRoot = process.env.DSH_SDK_ROOT ?? fileURLToPath(new URL('../../../../runtime/desktop/node_modules/', import.meta.url))
const sdkParent = pathToFileURL(join(sdkRoot, '..', 'memory-test-entry.mjs')).href

// Resolve real installed SDK modules without changing the plugin's node_modules.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('@deepseek-ai/')) throw error
      return nextResolve(specifier, { ...context, parentURL: sdkParent })
    }
  },
})
