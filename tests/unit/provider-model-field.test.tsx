// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ProviderModelField from '../../src/ProviderModelField'

afterEach(cleanup)
it('fetches with saved-key reference and selects without overwriting manual input', async () => {
  const query = vi.fn().mockResolvedValue(['model-a'])
  Object.defineProperty(window, 'agentManager', { configurable: true, value: { listProviderModels: query } })
  const onChange = vi.fn()
  render(<ProviderModelField baseUrl='https://example.com/v1' apiKey='' sessionId='session-1' disabled={false} deepseek={false} value='manual-model' onChange={onChange} />)
  fireEvent.click(screen.getByText('获取模型列表'))
  await screen.findByText('model-a')
  expect(query).toHaveBeenCalledWith({ baseUrl: 'https://example.com/v1', apiKey: '', sessionId: 'session-1', clearApiKey: undefined })
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('选择模型'), { target: { value: 'model-a' } })
  expect(onChange).toHaveBeenCalledWith('model-a')
})
it('discards responses when configuration changes', async () => {
  let resolve!: (models: string[]) => void
  Object.defineProperty(window, 'agentManager', { configurable: true, value: { listProviderModels: () => new Promise<string[]>(r => { resolve = r }) } })
  const props = { apiKey: '', disabled: false, deepseek: false, value: '', onChange: vi.fn() }
  const { rerender } = render(<ProviderModelField {...props} baseUrl='https://old.example.com' />)
  fireEvent.click(screen.getByText('获取模型列表'))
  rerender(<ProviderModelField {...props} baseUrl='https://new.example.com' />)
  resolve(['old-model'])
  await Promise.resolve()
  expect(screen.queryByText('old-model')).toBeNull()
})
