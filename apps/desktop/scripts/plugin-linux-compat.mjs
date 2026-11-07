/**
 * Diagnose Linux compatibility of plugins installed in a Desktop profile.
 *
 * Upstream ships macOS / Windows builds only, so third-party plugins are written
 * against those two platforms. A plugin that declares `os: ["darwin", "win32"]`,
 * ships only macOS native binaries, or requires a different Node version, can be
 * installed on Linux without any warning and then fail silently at runtime.
 *
 * This tool reads plugin manifests only (it never imports plugin code) and reports
 * which plugins can run on a Linux Desktop build, and why. It lives in
 * apps/desktop/scripts/, a path this fork owns (see OURS_PATHS in
 * .github/workflows/sync-upstream.yml), so daily upstream syncs cannot discard it.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import semver from 'semver'

/** Supported Linux Desktop targets. */
export const TARGETS = {
  'linux-x64': { platform: 'linux', arch: 'x64', libc: 'glibc' },
  'linux-arm64': { platform: 'linux', arch: 'arm64', libc: 'glibc' },
}

/**
 * Evaluate an npm `os` / `cpu` / `libc` field against one value of the running host.
 * npm allows bare allow-lists (`["darwin","win32"]`) and pure deny-lists (`["!linux"]`).
 * @param {unknown} field Manifest field value.
 * @param {string} host Platform, architecture, or libc of the running host.
 * @returns {boolean | undefined} true/false, or undefined when the field is absent/invalid.
 */
export function matchesHostField(field, host) {
  const list = Array.isArray(field) ? field : typeof field === 'string' ? [field] : undefined
  if (list === undefined) return undefined
  const values = list.filter(value => typeof value === 'string')
  if (values.length === 0) return undefined
  const denied = values.filter(value => value.startsWith('!')).map(value => value.slice(1))
  const allowed = values.filter(value => !value.startsWith('!'))
  if (denied.includes(host)) return false
  if (allowed.length === 0) return true
  return allowed.includes(host) || allowed.includes('any')
}

/**
 * Recognise a platform-specific native binary package name.
 * @param {string} name Dependency name.
 * @returns {{ platform: string, arch: string, libc?: string } | undefined}
 */
export function platformPackageHint(name) {
  if (name === 'fsevents') return { platform: 'darwin', arch: 'any' }
  const match = /(?:^|[-/])(darwin|win32|linux)-(x64|arm64|ia32|arm|universal)(?:-(gnu|musl))?(?=$|[-/])/u.exec(name)
  if (match === null) return undefined
  return { platform: match[1], arch: match[2], ...(match[3] === undefined ? {} : { libc: match[3] }) }
}

/** One diagnostic line about a plugin. */
/** @typedef {{ level: 'block' | 'warn', text: string }} Finding */

/** Match the upstream compatibility checker: inherited manifest fields are ignored. */
function own(manifest, field) {
  return Object.hasOwn(manifest, field) ? manifest[field] : undefined
}

/** Keys of an own object field, or an empty list when it is absent or malformed. */
function ownKeys(manifest, field) {
  const value = own(manifest, field)
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
}

/**
 * Inspect a single plugin manifest without loading the plugin.
 * @param {Record<string, unknown>} manifest Parsed package.json.
 * @param {{ platform: string, arch: string, libc: string }} target Host target.
 * @param {string | undefined} runtimeNode Node version of the host runtime.
 * @returns {{ verdict: 'incompatible' | 'unverified' | 'compatible', findings: Finding[] }}
 */
export function inspectManifest(manifest, target, runtimeNode) {
  /** @type {Finding[]} */
  const findings = []

  const osField = own(manifest, 'os')
  const os = matchesHostField(osField, target.platform)
  if (os === false) {
    findings.push({ level: 'block', text: `声明 os=${JSON.stringify(osField)}，不包含 ${target.platform}` })
  }
  const cpuField = own(manifest, 'cpu')
  const cpu = matchesHostField(cpuField, target.arch)
  if (cpu === false) {
    findings.push({ level: 'block', text: `声明 cpu=${JSON.stringify(cpuField)}，不包含 ${target.arch}` })
  }
  const libcField = own(manifest, 'libc')
  const libc = matchesHostField(libcField, target.libc)
  if (libc === false) {
    findings.push({ level: 'block', text: `声明 libc=${JSON.stringify(libcField)}，与本机 ${target.libc} 不符` })
  }

  const engines = own(manifest, 'engines')
  const nodeRange = engines !== null && typeof engines === 'object' && !Array.isArray(engines)
    && Object.hasOwn(engines, 'node') ? engines.node : undefined
  if (typeof nodeRange === 'string' && semver.validRange(nodeRange) !== null
    && runtimeNode !== undefined && semver.valid(runtimeNode) !== null) {
    if (!semver.satisfies(runtimeNode, nodeRange, { includePrerelease: true })) {
      findings.push({ level: 'block', text: `要求 Node ${nodeRange}，当前运行时是 ${runtimeNode}` })
    }
  }

  const hard = ownKeys(manifest, 'dependencies')
  const optional = ownKeys(manifest, 'optionalDependencies')

  for (const name of hard) {
    const hint = platformPackageHint(name)
    if (hint !== undefined && hint.platform !== target.platform) {
      findings.push({ level: 'block', text: `硬依赖 ${name} 是 ${hint.platform}/${hint.arch} 专属原生包，Linux 上装不上也跑不了` })
    }
  }

  // Optional native packages are how cross-platform binaries are normally shipped.
  // If a plugin offers native variants but none for this host, the Linux path degrades
  // or fails at load time rather than at install time — worth surfacing, not blocking.
  const nativeOptional = optional.map(name => ({ name, hint: platformPackageHint(name) }))
    .filter(entry => entry.hint !== undefined)
  if (nativeOptional.length > 0) {
    const hasHostVariant = nativeOptional.some(({ hint }) => hint.platform === target.platform
      && (hint.arch === target.arch || hint.arch === 'any' || hint.arch === 'universal'))
    if (!hasHostVariant) {
      const platforms = [...new Set(nativeOptional.map(({ hint }) => hint.platform))].join(', ')
      findings.push({ level: 'warn', text: `原生可选依赖只有 ${platforms} 版本，没有 ${target.platform}/${target.arch} 变体，运行时可能缺少原生能力` })
    }
  }

  const verdict = findings.some(finding => finding.level === 'block') ? 'incompatible'
    : findings.length > 0 ? 'unverified' : 'compatible'
  return { verdict, findings }
}

/** Human-readable labels used by the text report. */
const LABELS = {
  incompatible: '明确不兼容',
  unverified: '需要人工确认',
  compatible: '看起来可用',
  unknown: '无法读取',
}

/**
 * Render a plain-text Chinese report.
 * @param {Array<{ name: string, version: string, verdict: string, findings: Finding[] }>} results
 * @param {{ target: string, node?: string, profile: string, bundles?: readonly string[] }} options
 * @returns {string}
 */
export function renderReport(results, options) {
  const lines = []
  const target = TARGETS[options.target]
  lines.push(`插件兼容性诊断 · ${options.target}（${target.libc}）· Node ${options.node ?? process.versions.node}`)
  lines.push(`profile：${options.profile}`)
  lines.push('='.repeat(60))
  const counts = { incompatible: 0, unverified: 0, compatible: 0, unknown: 0 }
  for (const result of results) counts[result.verdict] = (counts[result.verdict] ?? 0) + 1
  lines.push(`共 ${results.length} 个插件：${counts.compatible} 个看起来可用，`
    + `${counts.incompatible} 个明确不兼容，${counts.unverified} 个需要人工确认`
    + `${counts.unknown > 0 ? `，${counts.unknown} 个无法读取` : ''}`)
  lines.push('')
  // A stock Desktop profile declares only built-in bundles in dsh.profile.bundles and
  // leaves dependencies empty. Reporting "0 plugins" without context reads like the
  // tool failed to scan, so spell out the difference between "no third-party plugins"
  // and "nothing could be inspected".
  if (results.length === 0) {
    lines.push('该 profile 的 dependencies / optionalDependencies 里没有第三方插件，因此没有可诊断的对象。')
    if (options.bundles !== undefined && options.bundles.length > 0) {
      lines.push(`内置 bundle（应用自带，不参与平台检查）：${options.bundles.join('、')}`)
    }
    lines.push('第三方插件装进 profile 后会写进 dependencies，届时重新运行本工具即可。')
    lines.push('')
  }
  for (const verdict of ['incompatible', 'unverified', 'unknown', 'compatible']) {
    const group = results.filter(result => result.verdict === verdict)
    if (group.length === 0) continue
    const mark = { incompatible: '×', unverified: '!', unknown: '?', compatible: '√' }[verdict]
    lines.push(`${mark} ${LABELS[verdict]}（${group.length}）`)
    for (const result of group) {
      lines.push(`  ${result.name}@${result.version}`)
      for (const finding of result.findings) lines.push(`    · ${finding.text}`)
      if (result.verdict === 'unknown') lines.push('    · package.json 读取失败或字段非法')
    }
    lines.push('')
  }
  if (counts.incompatible > 0) {
    lines.push('说明：明确不兼容的插件不会因为禁用就自动可用，通常需要插件作者补 Linux 支持。')
    lines.push('      先禁用它们可以让 Host 正常启动，再逐个验证其余插件。')
  }
  lines.push('提示：本工具只读 package.json，判断的是"能不能装上/加载"，不能替代真机运行验证。')
  return lines.join('\n').trimEnd() + '\n'
}

/**
 * Read what a Desktop profile declares, without loading any plugin code.
 *
 * Third-party plugins live in `dependencies` (and sometimes `optionalDependencies`)
 * with a matching node_modules entry. `dsh.profile.bundles` instead names built-in
 * bundles shipped inside the app; they are reported for context but never diagnosed.
 * @param {string} profileDir Profile directory holding package.json.
 * @returns {Promise<{ bundles: string[], names: string[] }>}
 */
export async function readProfileDeclarations(profileDir) {
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { bundles: [], names: [] }
  }
  const dsh = own(manifest, 'dsh')
  const profile = dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)
    && Object.hasOwn(dsh, 'profile') ? dsh.profile : undefined
  const bundles = profile !== null && typeof profile === 'object' && !Array.isArray(profile)
    && Array.isArray(profile.bundles) ? profile.bundles.filter(name => typeof name === 'string') : []
  const names = [...new Set([...ownKeys(manifest, 'dependencies'), ...ownKeys(manifest, 'optionalDependencies')])]
  return { bundles, names }
}

/**
 * Read the plugins a Desktop profile declares, then inspect each installed manifest.
 * @param {string} profileDir Profile directory holding package.json and node_modules.
 * @param {{ platform: string, arch: string, libc: string }} target Host target.
 * @param {string | undefined} runtimeNode Node version of the host runtime.
 * @returns {Promise<Array<{ name: string, version: string, verdict: string, findings: Finding[] }>>}
 */
export async function inspectProfile(profileDir, target, runtimeNode) {
  const { names } = await readProfileDeclarations(profileDir)
  const results = []
  for (const name of names) {
    let pkg
    try {
      pkg = JSON.parse(await readFile(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
    } catch {
      results.push({ name, version: '?', verdict: 'unknown', findings: [] })
      continue
    }
    if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
      results.push({ name, version: '?', verdict: 'unknown', findings: [] })
      continue
    }
    const { verdict, findings } = inspectManifest(pkg, target, runtimeNode)
    results.push({ name, version: typeof pkg.version === 'string' ? pkg.version : '?', verdict, findings })
  }
  return results
}

/** Resolve the Desktop profile directory from an explicit path or DSH_HOME. */
export function resolveProfileDir(explicit) {
  if (explicit !== undefined) return resolve(explicit)
  const home = process.env.DSH_HOME
  if (home === undefined || home.trim() === '') {
    throw new Error('未找到 DSH_HOME，请用 --profile <目录> 指定桌面端 profile（通常位于 $DSH_HOME/profiles/desktop）')
  }
  return join(home, 'profiles', 'desktop')
}

/** CLI entry point. */
export async function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    profile: { type: 'string' },
    target: { type: 'string', default: 'linux-x64' },
    node: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } })
  if (values.help === true) {
    process.stdout.write([
      '用法：node scripts/plugin-linux-compat.mjs [选项]',
      '',
      '  --profile <目录>  Desktop profile 目录（默认取 $DSH_HOME/profiles/desktop）',
      '  --target <名称>   linux-x64（默认）或 linux-arm64',
      '  --node <版本>     Host 运行时的 Node 版本（默认当前进程）',
      '  --json            输出结构化 JSON 而不是中文报告',
      '  --help            显示本说明',
      '',
      '只读插件的 package.json，不加载插件代码，不修改任何文件。',
      '只诊断 dependencies / optionalDependencies 里的第三方插件；',
      'dsh.profile.bundles 里的内置 bundle 仅在报告中列出，不参与平台检查。',
      '',
    ].join('\n'))
    return
  }
  const targetName = values.target
  if (TARGETS[targetName] === undefined) {
    throw new Error(`未知目标 ${JSON.stringify(targetName)}，可选：${Object.keys(TARGETS).join(', ')}`)
  }
  const profile = resolveProfileDir(values.profile)
  const runtimeNode = values.node ?? process.versions.node
  const { bundles } = await readProfileDeclarations(profile)
  const results = await inspectProfile(profile, TARGETS[targetName], runtimeNode)
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ profile, target: targetName, node: runtimeNode, bundles, results }, null, 2)}\n`)
  } else {
    process.stdout.write(renderReport(results, { target: targetName, node: runtimeNode, profile, bundles }))
  }
  if (results.some(result => result.verdict === 'incompatible')) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`plugin-linux-compat: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
