/** Optional XWayland launcher: session detection, advice, and idempotent flags. */
import { describe, expect, it } from 'vitest'
import { COMPAT_FLAG, detectSession, resolveLaunchAdvice } from '../scripts/linux-launch-compat.mjs'

describe('graphical session detection', () => {
  it('prefers an explicit wayland session type', () => {
    expect(detectSession({ XDG_SESSION_TYPE: 'wayland' })).toBe('wayland')
    expect(detectSession({ XDG_SESSION_TYPE: 'WAYLAND' })).toBe('wayland')
  })

  it('recognises an x11 session', () => {
    expect(detectSession({ XDG_SESSION_TYPE: 'x11' })).toBe('x11')
    expect(detectSession({ DISPLAY: ':0' })).toBe('x11')
  })

  it('falls back to WAYLAND_DISPLAY when session type is absent', () => {
    expect(detectSession({ WAYLAND_DISPLAY: 'wayland-0' })).toBe('wayland')
  })

  it('does not let an XWayland DISPLAY hide a wayland session', () => {
    expect(detectSession({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe('wayland')
  })

  it('reports unknown on a headless environment', () => {
    expect(detectSession({})).toBe('unknown')
    expect(detectSession({ DISPLAY: '  ' })).toBe('unknown')
  })
})

describe('launch advice', () => {
  it('adds the compat flag on a native wayland session', () => {
    const advice = resolveLaunchAdvice({ XDG_SESSION_TYPE: 'wayland' }, './app.AppImage')
    expect(advice.session).toBe('wayland')
    expect(advice.needsFlag).toBe(true)
    expect(advice.command).toBe(`./app.AppImage ${COMPAT_FLAG}`)
    expect(advice.notes.join('\n')).toContain('分数缩放')
  })

  it('leaves an x11 command untouched', () => {
    const advice = resolveLaunchAdvice({ DISPLAY: ':0' }, './app.AppImage', ['--foo'])
    expect(advice.needsFlag).toBe(false)
    expect(advice.command).toBe('./app.AppImage --foo')
  })

  it('never adds the flag twice', () => {
    const advice = resolveLaunchAdvice({ XDG_SESSION_TYPE: 'wayland' }, './app.AppImage', [COMPAT_FLAG])
    expect(advice.needsFlag).toBe(false)
    expect(advice.command).toBe(`./app.AppImage ${COMPAT_FLAG}`)
    expect(advice.notes.join('\n')).toContain('已带 ozone-platform')
  })

  it('respects a user-chosen ozone platform', () => {
    const advice = resolveLaunchAdvice({ XDG_SESSION_TYPE: 'wayland' }, './app.AppImage', ['--ozone-platform=wayland'])
    expect(advice.needsFlag).toBe(false)
    expect(advice.command).toBe('./app.AppImage --ozone-platform=wayland')
  })

  it('only suggests on a headless host instead of forcing a flag', () => {
    const advice = resolveLaunchAdvice({}, './app.AppImage')
    expect(advice.needsFlag).toBe(false)
    expect(advice.notes.join('\n')).toContain('未能识别会话类型')
  })
})
