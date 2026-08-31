import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'

const ORIGIN = 'https://github.com/russf74/ViewerOne.git'

function findGit(): string | null {
  const fromPath = spawnSync('where', ['git.exe'], { encoding: 'utf8', windowsHide: true })
  const first = fromPath.stdout?.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
  if (first && existsSync(first)) return first
  const fallbacks = [
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
    'C:\\Program Files\\Git\\cmd\\git.exe'
  ]
  return fallbacks.find((p) => existsSync(p)) ?? null
}

export function findRepoRoot(): string | null {
  const starts = [process.cwd(), join(app.getAppPath(), '..', '..'), join(app.getAppPath(), '..')]
  for (const dir of starts) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, '.git'))) return dir
  }
  return null
}

/**
 * If this checkout is behind GitHub main, quit and let ViewerOne-Launch-Silent.cmd
 * reset / rebuild / relaunch. Skipped when VIEWERONE_SKIP_SYNC=1 (after that cmd starts us).
 * Returns true when this process should exit.
 */
export function relaunchFromGithubIfBehind(): boolean {
  if (process.platform !== 'win32') return false
  if (process.env.VIEWERONE_SKIP_SYNC === '1') return false

  const repo = findRepoRoot()
  if (!repo) return false
  const git = findGit()
  if (!git) return false

  const run = (args: string[]) =>
    spawnSync(git, args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 45000 })

  run(['remote', 'set-url', 'origin', ORIGIN])
  const fetch = run(['fetch', 'origin', 'main'])
  if (fetch.status !== 0) return false

  const head = (run(['rev-parse', 'HEAD']).stdout || '').trim()
  const remote = (run(['rev-parse', 'origin/main']).stdout || '').trim()
  if (!head || !remote || head === remote) return false

  const cmd = join(repo, 'ViewerOne-Launch-Silent.cmd')
  if (!existsSync(cmd)) return false

  const runPath = join(tmpdir(), 'viewerone-launch-run.cmd')
  try {
    copyFileSync(cmd, runPath)
  } catch {
    return false
  }

  spawn('cmd.exe', ['/c', runPath, repo], {
    cwd: repo,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref()
  return true
}
