import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ps1 = join(root, 'scripts', 'install-viewerone-shortcut.ps1')

if (process.platform !== 'win32') {
  console.log('install-shortcut: skipped (Windows only — run on your PC after git pull)')
  process.exit(0)
}

const shell = process.env.ComSpec || 'cmd.exe'
const r = spawnSync(
  shell,
  ['/d', '/s', '/c', `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`],
  { stdio: 'inherit', cwd: root }
)
process.exit(r.status ?? 1)
