/**
 * Optional launcher for Linux sessions where plugin windows do not receive clicks.
 *
 * Electron's transparent / always-on-top windows need X11 semantics. On a native
 * Wayland session the compositor does not let an application control stacking or
 * input regions, so a plugin window can be visible yet unclickable (issue #25).
 * Passing --ozone-platform=x11 runs the app through XWayland and restores those
 * semantics, at the cost of native-Wayland fractional scaling.
 *
 * This is deliberately an opt-in helper, not a change to the packaged launcher:
 * forcing X11 on every user would regress HiDPI scaling and would fail on hosts
 * without XWayland. It never imports Electron or touches application code; it lives
 * in apps/desktop/scripts/, a path this fork owns (OURS_PATHS in sync-upstream.yml).
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** The only flag this helper adds. */
export const COMPAT_FLAG = '--ozone-platform=x11'

/**
 * Classify the graphical session from its environment.
 * @param {NodeJS.ProcessEnv} env
 * @returns {'wayland' | 'x11' | 'unknown'}
 */
export function detectSession(env) {
  const type = env.XDG_SESSION_TYPE?.trim().toLowerCase()
  if (type === 'wayland') return 'wayland'
  if (type === 'x11') return 'x11'
  // XDG_SESSION_TYPE is unset on some display managers; WAYLAND_DISPLAY is the
  // reliable fallback. DISPLAY is also set under XWayland, so it cannot override it.
  if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY.trim() !== '') return 'wayland'
  if (env.DISPLAY !== undefined && env.DISPLAY.trim() !== '') return 'x11'
  return 'unknown'
}

/**
 * Decide what to tell the user for this session.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} executable AppImage / binary path shown in the suggested command.
 * @param {readonly string[]} extraArgs Arguments the user already wants to pass.
 * @returns {{ session: string, needsFlag: boolean, command: string, notes: string[] }}
 */
export function resolveLaunchAdvice(env, executable, extraArgs = []) {
  const session = detectSession(env)
  const already = extraArgs.includes(COMPAT_FLAG)
    || extraArgs.some(arg => arg.startsWith('--ozone-platform='))
  const needsFlag = session === 'wayland' && !already
  const args = [...(needsFlag ? [COMPAT_FLAG] : []), ...extraArgs]
  const command = [executable, ...args].join(' ')
  const notes = []
  if (session === 'wayland') {
    notes.push('检测到原生 Wayland 会话：插件的透明/置顶窗口可能显示但无法点击。')
    notes.push(`${COMPAT_FLAG} 会让应用走 XWayland，恢复点击与置顶行为。`)
    notes.push('代价：原生 Wayland 的分数缩放会失效，HiDPI 屏幕可能略显模糊；机器上需要装有 XWayland。')
  } else if (session === 'x11') {
    notes.push('检测到 X11 会话：窗口层叠与点击穿透本来就可用，无需兼容性参数。')
  } else {
    notes.push('未能识别会话类型（无图形环境变量）；如插件窗口点不动，可手动加上兼容性参数再试。')
  }
  if (already) notes.push('命令行已带 ozone-platform 参数，不再重复添加。')
  return { session, needsFlag, command, notes }
}

/** CLI entry point. */
export async function main(argv) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    exec: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } })
  if (values.help === true || positionals.length === 0) {
    process.stdout.write([
      '用法：node scripts/linux-launch-compat.mjs [--exec] <AppImage 或可执行文件> [-- <应用参数...>]',
      '',
      '  默认只打印建议命令，不启动任何进程。',
      '  --exec  带参数真正启动；仅在原生 Wayland 会话下追加 --ozone-platform=x11。必须写在 -- 之前。',
      '  --      分隔本脚本选项与应用参数。应用参数以 - 开头时必须加 --，否则会报 Unknown option。',
      '  --help  显示本说明。',
      '',
      '  示例：node scripts/linux-launch-compat.mjs --exec ./app.AppImage -- --enable-logging',
      '',
      '用途：Wayland 下插件窗口"看得见但点不动"时的可选绕过方式。',
      '',
    ].join('\n'))
    return
  }
  const [executable, ...extraArgs] = positionals
  const advice = resolveLaunchAdvice(process.env, executable, extraArgs)
  for (const note of advice.notes) process.stdout.write(`${note}\n`)
  process.stdout.write(`\n建议命令：\n  ${advice.command}\n`)
  if (values.exec !== true) {
    process.stdout.write('\n（未加 --exec，未启动任何进程）\n')
    return
  }
  const args = [...(advice.needsFlag ? [COMPAT_FLAG] : []), ...extraArgs]
  const child = spawn(resolve(executable), args, { stdio: 'inherit', shell: false })
  child.on('error', error => {
    process.stderr.write(`linux-launch-compat: 启动失败：${error.message}\n`)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    if (signal !== null) process.exitCode = 1
    else if (code !== null && code !== 0) process.exitCode = code
  })
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`linux-launch-compat: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
