import { expect, it } from 'vitest'
import { join } from 'node:path'
import { discoverBindableSessions, type NativeSessionDiscoveryReader } from '../../electron/native-session-discovery'

it('lists actual Claude transcripts, excluding missing, foreign and subagent history', async () => {
  const root = 'fixture'
  const workspace = 'B:\\work'
  const files = {
    [join(root, 'history.jsonl')]: JSON.stringify({ sessionId: 'missing', project: workspace, display: 'deleted history' }),
    [join(root, 'projects', 'work', 'real.jsonl')]: JSON.stringify({ sessionId: 'real', cwd: workspace, type: 'user', message: { content: 'hello' } }),
    [join(root, 'projects', 'other', 'foreign.jsonl')]: JSON.stringify({ sessionId: 'foreign', cwd: 'B:\\elsewhere', type: 'user' }),
    [join(root, 'projects', 'work', 'subagents', 'child.jsonl')]: JSON.stringify({ sessionId: 'child', cwd: workspace, type: 'user' }),
    [join(root, 'projects', 'work', 'empty.jsonl')]: JSON.stringify({ type: 'file-history-snapshot' }),
  }
  const reader: NativeSessionDiscoveryReader = {
    listFiles: async () => Object.keys(files).filter(file => file.includes('projects')),
    readLines: file => (async function* () { if (files[file]) yield files[file] })(),
    readFirstLine: async file => files[file] ?? '', mtime: async () => 10,
  }
  expect(await discoverBindableSessions('claude', workspace, { roots: { claude: root }, reader })).toEqual([{ id: 'real', workspace, title: 'real', updatedAt: 10 }])
})
