import { describe, expect, it } from 'vitest'

import { permissionHookFields } from '../../electron/permission-hook-input'

describe('permission hook input extraction', () => {
  it('retains full raw multiline commands through the common 16384-character limit', () => {
    const command = 'python -c "\n' + '# package diagnostics\n'.repeat(150) + 'print(1)\n"'
    expect(command.length).toBeGreaterThan(2048)
    expect(permissionHookFields({ command })).toEqual({ command })
    const maximum = 'x'.repeat(16384)
    expect(permissionHookFields({ command: maximum })).toEqual({ command: maximum })
    expect(permissionHookFields({ command: maximum + 'x' })).toEqual({ inputTruncated: true })
  })

  it.each([null, 42, '', ' ', 'echo \0bad', [], ['pwsh', null, '-Command', 'Get-Location'], ['pwd', 42], ['', 'argument']])(
    'marks invalid command input incomplete without keeping a filtered subset: %j', (command) => {
      expect(permissionHookFields({ command })).toEqual({ inputTruncated: true })
    },
  )

  it('keeps valid argv boundaries in toolInput instead of inventing a shell command', () => {
    expect(permissionHookFields({ command: ['pwsh', '-Command', "Get-Location\nWrite-Output 'two words'"] })).toEqual({})
    expect(permissionHookFields({ command: ['python', '-c', '# diagnostic\n'.repeat(400) + '\nprint(1)', ''] })).toEqual({})
    expect(permissionHookFields({ command: ['python', '-c', 'x'.repeat(16384)] })).toEqual({ inputTruncated: true })
  })

  it('never filters invalid target paths into an apparently complete operation', () => {
    expect(permissionHookFields({ paths: ['C:\\safe', null, 'D:\\other'] })).toEqual({ inputTruncated: true })
    expect(permissionHookFields({ paths: ['C:\\safe', 'D:\\other'] })).toEqual({ targetPaths: ['C:\\safe', 'D:\\other'] })
    expect(permissionHookFields({ path: 'x'.repeat(4097) })).toEqual({ inputTruncated: true })
    expect(permissionHookFields({ paths: Array.from({ length: 101 }, (_, index) => 'path-' + index) })).toEqual({ inputTruncated: true })
  })
})
