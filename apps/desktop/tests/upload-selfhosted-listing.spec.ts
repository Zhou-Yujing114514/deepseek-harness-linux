/** Remote directory listings have to survive whatever characters a file name carries. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRemoteListing } from '../scripts/upload-selfhosted.mjs'

// `find -printf` is a GNU extension; the parser cases below stand on their own where it is missing.
const supportsPrintf = (() => {
  try {
    execFileSync('find', ['.', '-maxdepth', '0', '-printf', '%s\\n'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('self-hosted remote listing', () => {
  it('maps file names to their sizes', () => {
    const listing = parseRemoteListing('12\tdeepseek-harness-0.2.1-linux-x64.AppImage\n7\tnightly-linux.yml\n')
    expect(listing.get('deepseek-harness-0.2.1-linux-x64.AppImage')).toBe(12)
    expect(listing.get('nightly-linux.yml')).toBe(7)
    expect(listing.size).toBe(2)
  })

  it('keeps a name containing spaces whole', () => {
    // Splitting `ls -l` on whitespace left only the last word, so an already-uploaded
    // artifact named like this never matched its recorded size and went up again every run.
    expect(parseRemoteListing('100\tname with spaces.AppImage\n').get('name with spaces.AppImage')).toBe(100)
  })

  it('keeps a name containing a tab whole', () => {
    expect(parseRemoteListing('100\tbefore\tafter.AppImage\n').get('before\tafter.AppImage')).toBe(100)
  })

  it('skips blank lines and entries whose size is not a whole number', () => {
    expect(parseRemoteListing('').size).toBe(0)
    expect(parseRemoteListing('\n\n').size).toBe(0)
    expect(parseRemoteListing('no-tab-here.AppImage\n').size).toBe(0)
    expect(parseRemoteListing('not-a-size\tfile.AppImage\n').size).toBe(0)
    expect(parseRemoteListing('1.5\tfile.AppImage\n').size).toBe(0)
  })

  it.skipIf(!supportsPrintf)('round-trips the output of the real find command', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-listing-'))
    writeFileSync(join(directory, 'deepseek-harness-0.2.1-linux-x64.AppImage'), 'x'.repeat(11))
    writeFileSync(join(directory, 'name with spaces.AppImage'), 'y'.repeat(23))
    const stdout = execFileSync(
      'find', [directory, '-maxdepth', '1', '-type', 'f', '-printf', '%s\\t%f\\n'], { encoding: 'utf8' },
    )
    const listing = parseRemoteListing(stdout)
    expect(listing.get('deepseek-harness-0.2.1-linux-x64.AppImage')).toBe(11)
    expect(listing.get('name with spaces.AppImage')).toBe(23)
  })
})
