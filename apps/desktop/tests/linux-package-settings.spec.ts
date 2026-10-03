import { expect, it } from 'vitest'
import { resolveLinuxPackageSettings } from '../scripts/linux-package-settings.mjs'

it('defaults to four workspace tarball workers', () => {
  expect(resolveLinuxPackageSettings({})).toEqual({ packConcurrency: 4 })
  expect(resolveLinuxPackageSettings({ DSH_DESKTOP_LINUX_PACK_CONCURRENCY: '2' })).toEqual({ packConcurrency: 2 })
})

it.each(['', '0', '-1', '1.5', '1e2', 'Infinity', '9007199254740992', '9'])('rejects invalid concurrency %j', (value) => {
  expect(() => resolveLinuxPackageSettings({ DSH_DESKTOP_LINUX_PACK_CONCURRENCY: value })).toThrow('PACK_CONCURRENCY')
})
