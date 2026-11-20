import { delimiter, join } from 'node:path'
import { expect, it } from 'vitest'
import { desktopNodeEnvironment, desktopNodeRuntime } from '../src/node-environment.ts'

const ELECTRON = '/desktop/electron'
const PRIMARY_RUNTIME = '/desktop/runtime/primary-runtime'

it('hosts the payload in the primary runtime standalone Node on Linux and in Electron elsewhere', () => {
  expect(desktopNodeRuntime('linux', ELECTRON, PRIMARY_RUNTIME)).toEqual({
    executable: join(PRIMARY_RUNTIME, 'dependencies', 'node', 'bin', 'node'), electron: false,
  })
  expect(desktopNodeRuntime('darwin', ELECTRON, PRIMARY_RUNTIME)).toEqual({ executable: ELECTRON, electron: true })
  expect(desktopNodeRuntime('win32', ELECTRON, PRIMARY_RUNTIME)).toEqual({ executable: ELECTRON, electron: true })
})

it('keeps private Desktop launchers out of the Host environment inherited by PTC', () => {
  const environment = { PATH: '/user/bin', HOME: '/user' }
  expect(desktopNodeEnvironment({ executable: ELECTRON, electron: true }, undefined, environment)).toEqual({
    ...environment, ELECTRON_RUN_AS_NODE: '1',
  })
  expect(environment).toEqual({ PATH: '/user/bin', HOME: '/user' })
})

it('marks a standalone Host runtime as not Electron for the package scripts it launches', () => {
  const environment = { PATH: '/user/bin', HOME: '/user' }
  expect(desktopNodeEnvironment({ executable: '/desktop/node', electron: false }, undefined, environment)).toEqual({
    ...environment, DSH_DESKTOP_NODE_ELECTRON: '0',
  })
})

it('hands the packaged resources root only to a standalone runtime that states one', () => {
  const environment = { PATH: '/user/bin', HOME: '/user' }
  // A standalone runtime republishes the resources root it was given; without one the environment
  // stays free of the marker, and an Electron runtime never states it (it owns the real thing).
  expect(desktopNodeEnvironment({ executable: '/desktop/node', electron: false, resourcesPath: '/packaged/resources' }, undefined, environment)).toEqual({
    ...environment, DSH_DESKTOP_NODE_ELECTRON: '0', DSH_DESKTOP_RESOURCES_PATH: '/packaged/resources',
  })
  expect(desktopNodeEnvironment({ executable: '/desktop/node', electron: false }, undefined, environment)).toEqual({
    ...environment, DSH_DESKTOP_NODE_ELECTRON: '0',
  })
  expect(desktopNodeEnvironment({ executable: ELECTRON, electron: true, resourcesPath: '/packaged/resources' }, undefined, environment)).toEqual({
    ...environment, ELECTRON_RUN_AS_NODE: '1',
  })
})

it('provides private launchers only to package installation processes', () => {
  expect(desktopNodeEnvironment({ executable: ELECTRON, electron: true }, '/desktop/bin', { PATH: '/user/bin' })).toEqual({
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: ELECTRON,
    PATH: `/desktop/bin${delimiter}/user/bin`,
  })
  expect(desktopNodeEnvironment({ executable: '/desktop/node', electron: false }, '/desktop/bin', { PATH: '/user/bin' })).toEqual({
    DSH_DESKTOP_NODE_ELECTRON: '0',
    DSH_DESKTOP_NODE_EXECUTABLE: '/desktop/node',
    PATH: `/desktop/bin${delimiter}/user/bin`,
  })
})
