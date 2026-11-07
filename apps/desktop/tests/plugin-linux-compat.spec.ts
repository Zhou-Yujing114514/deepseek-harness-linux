/** Linux plugin compatibility diagnosis: platform fields, native packages, and report output. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TARGETS,
  inspectManifest,
  inspectProfile,
  matchesHostField,
  platformPackageHint,
  readProfileDeclarations,
  renderReport,
  resolveProfileDir,
} from '../scripts/plugin-linux-compat.mjs'
import type { PluginResult } from '../scripts/plugin-linux-compat.mjs'

const x64 = TARGETS['linux-x64']

afterEach(() => { delete process.env.DSH_HOME })

describe('npm os/cpu/libc field matching', () => {
  it('treats an absent field as no restriction', () => {
    expect(matchesHostField(undefined, 'linux')).toBeUndefined()
    expect(matchesHostField([], 'linux')).toBeUndefined()
    expect(matchesHostField(42, 'linux')).toBeUndefined()
  })

  it('rejects an allow-list that omits linux', () => {
    expect(matchesHostField(['darwin', 'win32'], 'linux')).toBe(false)
    expect(matchesHostField(['darwin', 'linux'], 'linux')).toBe(true)
    expect(matchesHostField('darwin', 'linux')).toBe(false)
  })

  it('honours deny-list entries', () => {
    expect(matchesHostField(['!linux'], 'linux')).toBe(false)
    expect(matchesHostField(['!win32'], 'linux')).toBe(true)
  })

  it('accepts the npm "any" wildcard', () => {
    expect(matchesHostField(['any'], 'linux')).toBe(true)
  })

  it('matches architecture independently of platform', () => {
    expect(matchesHostField(['x64'], 'x64')).toBe(true)
    expect(matchesHostField(['arm64'], 'x64')).toBe(false)
    expect(TARGETS['linux-arm64'].arch).toBe('arm64')
  })
})

describe('platform-specific package names', () => {
  it('recognises common native binary packages', () => {
    expect(platformPackageHint('@img/sharp-libvips-darwin-arm64')).toMatchObject({ platform: 'darwin', arch: 'arm64' })
    expect(platformPackageHint('@img/sharp-linux-x64')).toMatchObject({ platform: 'linux', arch: 'x64' })
    expect(platformPackageHint('@rollup/rollup-linux-x64-gnu')).toMatchObject({ platform: 'linux', arch: 'x64', libc: 'gnu' })
    expect(platformPackageHint('fsevents')).toMatchObject({ platform: 'darwin' })
  })

  it('leaves ordinary package names alone', () => {
    expect(platformPackageHint('lodash')).toBeUndefined()
    expect(platformPackageHint('@deepseek-ai/dsh-host')).toBeUndefined()
    expect(platformPackageHint('cordis')).toBeUndefined()
  })
})

describe('manifest verdicts', () => {
  it('admits a plugin with no platform declarations', () => {
    expect(inspectManifest({ name: 'plain', version: '1.0.0' }, x64, '22.19.0').verdict).toBe('compatible')
  })

  it('blocks a plugin declaring macOS/Windows only', () => {
    const result = inspectManifest({ name: 'mac-only', version: '1.0.0', os: ['darwin', 'win32'] }, x64, '22.19.0')
    expect(result.verdict).toBe('incompatible')
    expect(result.findings[0]?.text).toContain('不包含 linux')
  })

  it('blocks a plugin pinned to the wrong architecture', () => {
    expect(inspectManifest({ cpu: ['arm64'], libc: ['musl'] }, x64, '22.19.0').verdict).toBe('incompatible')
  })

  it('blocks a plugin hard-depending on a Windows native binary', () => {
    const result = inspectManifest({ dependencies: { '@img/sharp-win32-x64': '0.35.5' } }, x64, '22.19.0')
    expect(result.verdict).toBe('incompatible')
    expect(result.findings[0]?.text).toContain('硬依赖')
  })

  it('blocks a plugin requiring a newer Node than the host', () => {
    const result = inspectManifest({ engines: { node: '>=24' } }, x64, '22.19.0')
    expect(result.verdict).toBe('incompatible')
    expect(result.findings[0]?.text).toContain('Node >=24')
  })

  it('does not fail on an unparseable engine range', () => {
    expect(inspectManifest({ engines: { node: 'not-a-range' } }, x64, '22.19.0').verdict).toBe('compatible')
  })

  it('warns but does not block when native optional variants omit linux', () => {
    const result = inspectManifest({
      optionalDependencies: {
        '@img/sharp-darwin-arm64': '0.35.5',
        '@img/sharp-win32-x64': '0.35.5',
      },
    }, x64, '22.19.0')
    expect(result.verdict).toBe('unverified')
    expect(result.findings[0]?.level).toBe('warn')
  })

  it('accepts a plugin that ships a linux x64 native variant', () => {
    const result = inspectManifest({
      optionalDependencies: {
        '@img/sharp-darwin-arm64': '0.35.5',
        '@img/sharp-linux-x64': '0.35.5',
      },
    }, x64, '22.19.0')
    expect(result.verdict).toBe('compatible')
  })

  it('ignores inherited manifest fields', () => {
    const inherited = Object.create({ os: ['darwin'] }) as Record<string, unknown>
    expect(inspectManifest(inherited, x64, '22.19.0').verdict).toBe('compatible')
  })
})

describe('profile inspection', () => {
  const created: string[] = []
  const profile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-compat-'))
    created.push(dir)
    return dir
  }
  const plugin = (dir: string, name: string, manifest: object) => {
    const target = join(dir, 'node_modules', name)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify(manifest))
  }

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reports declared plugins in manifest order and marks missing ones unknown', async () => {
    const dir = profile()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0', b: '1.0.0', missing: '1.0.0' } }))
    plugin(dir, 'a', { name: 'a', version: '1.0.0' })
    plugin(dir, 'b', { name: 'b', version: '2.0.0', os: ['darwin'] })
    const results = await inspectProfile(dir, x64, '22.19.0')
    expect(results.map(entry => entry.name)).toEqual(['a', 'b', 'missing'])
    expect(results.map(entry => entry.verdict)).toEqual(['compatible', 'incompatible', 'unknown'])
    expect(results[1]?.version).toBe('2.0.0')
  })

  it('treats a malformed installed manifest as unknown rather than throwing', async () => {
    const dir = profile()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { broken: '1.0.0' } }))
    const target = join(dir, 'node_modules', 'broken')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), '{')
    expect((await inspectProfile(dir, x64, '22.19.0'))[0]?.verdict).toBe('unknown')
  })
})

describe('profile declarations', () => {
  const created: string[] = []
  const profile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-compat-decl-'))
    created.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reads built-in bundles from a stock Desktop profile', async () => {
    const dir = profile()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }))
    const declarations = await readProfileDeclarations(dir)
    expect(declarations.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(declarations.names).toEqual([])
  })

  it('merges dependencies and optionalDependencies without duplicates', async () => {
    const dir = profile()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { a: '1.0.0', shared: '1.0.0' },
      optionalDependencies: { shared: '1.0.0', c: '1.0.0' },
    }))
    const declarations = await readProfileDeclarations(dir)
    expect(declarations.names).toEqual(['a', 'shared', 'c'])
    expect(declarations.bundles).toEqual([])
  })

  it('ignores a malformed dsh block', async () => {
    const dir = profile()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: 'not-an-object', dependencies: {} }))
    expect(await readProfileDeclarations(dir)).toEqual({ bundles: [], names: [] })
  })

  it('returns no results for a bundle-only profile', async () => {
    const dir = profile()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
    expect(await inspectProfile(dir, x64, '22.19.0')).toEqual([])
  })
})

describe('report rendering', () => {
  const results: PluginResult[] = [
    { name: 'good', version: '1.0.0', verdict: 'compatible', findings: [] },
    { name: 'bad', version: '2.0.0', verdict: 'incompatible', findings: [{ level: 'block', text: '声明 os=["darwin"]' }] },
  ]
  const options = { target: 'linux-x64', node: '22.19.0', profile: '/tmp/profiles/desktop' }

  it('groups by verdict and prints counts', () => {
    const report = renderReport(results, options)
    expect(report).toContain('共 2 个插件：1 个看起来可用，1 个明确不兼容')
    expect(report).toContain('× 明确不兼容（1）')
    expect(report).toContain('  bad@2.0.0')
    expect(report).toContain('声明 os=["darwin"]')
  })

  it('does not claim a real runtime test was performed', () => {
    expect(renderReport(results, options)).toContain('不能替代真机运行验证')
  })

  it('explains an empty stock profile instead of looking like a failed scan', () => {
    const report = renderReport([], {
      ...options,
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    })
    expect(report).toContain('没有第三方插件')
    expect(report).toContain('内置 bundle')
    expect(report).toContain('@deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app')
    expect(report).toContain('重新运行本工具')
  })

  it('keeps the empty-profile note out of a populated report', () => {
    expect(renderReport(results, options)).not.toContain('没有第三方插件')
  })
})

describe('profile directory resolution', () => {
  it('uses DSH_HOME when no explicit path is given', () => {
    process.env.DSH_HOME = '/srv/dsh'
    expect(resolveProfileDir(undefined)).toBe(join('/srv/dsh', 'profiles', 'desktop'))
  })

  it('explains what to pass when DSH_HOME is missing', () => {
    expect(() => resolveProfileDir(undefined)).toThrow(/--profile/u)
  })

  it('resolves an explicit path', () => {
    expect(resolveProfileDir('relative/profile')).toBe(join(process.cwd(), 'relative/profile'))
  })
})
