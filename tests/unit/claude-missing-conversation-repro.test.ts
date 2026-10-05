import { mkdtemp, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { discoverNativeSessions, discoverBindableSessions } from '../../electron/native-session-discovery'

it('仅有 Claude 输入历史时，旧读取器返回 ID，但正式绑定列表拒绝无对话文件的记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atm-claude-missing-repro-'))
  const id = '00000000-0000-4000-8000-000000000091'
  const workspace = 'E:\\Code\\ai\\demo-repro'
  await writeFile(join(root, 'history.jsonl'), JSON.stringify({ sessionId: id, project: workspace, display: 'hello', timestamp: Date.now() }) + '\n')
  const first = await discoverNativeSessions('claude', workspace, { roots: { claude: root } })
  const afterRestart = await discoverNativeSessions('claude', workspace, { roots: { claude: root } })
  expect(first.map(item => item.id)).toContain(id)
  expect(afterRestart.map(item => item.id)).toContain(id)
  await expect(access(join(root, 'projects'))).rejects.toThrow()
  expect(await discoverBindableSessions('claude', workspace, { roots: { claude: root } })).toEqual([])
})
