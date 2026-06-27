import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEBSITE = join(__dirname, '..')
const template = readFileSync(join(WEBSITE, 'og-template.html'), 'utf8')

const externalFontHosts = ['fonts.googleapis.com', 'fonts.gstatic.com']
const externalHost = externalFontHosts.find((host) => template.includes(host))
if (externalHost) {
  throw new Error(`OG template must not depend on ${externalHost}; vendor fonts locally for deterministic output.`)
}

const requiredFonts = [
  'cormorant-normal.woff2',
  'inter-normal.woff2',
  'jetbrains-mono-normal.woff2',
  'jetbrains-mono-italic.woff2',
]
for (const font of requiredFonts) {
  const path = join(WEBSITE, 'public', 'fonts', font)
  if (!existsSync(path)) {
    throw new Error(`Missing vendored OG font: ${path}`)
  }
  if (!template.includes(`public/fonts/${font}`)) {
    throw new Error(`OG template does not reference vendored font: ${font}`)
  }
}

console.log(`OG template uses ${requiredFonts.length} vendored font file(s).`)
