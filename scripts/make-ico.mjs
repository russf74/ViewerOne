import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pngPath = path.join(root, 'build', 'icon.png')
const icoPath = path.join(root, 'build', 'icon.ico')

if (!fs.existsSync(pngPath)) {
  console.error('Missing', pngPath)
  process.exit(1)
}

const squarePng = await sharp(pngPath).resize(512, 512, { fit: 'cover' }).png().toBuffer()
const ico = await pngToIco(squarePng)
fs.writeFileSync(icoPath, ico)
console.log('Wrote', icoPath)
