import { beforeEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { fetchProviderModels, modelsEndpoint } from '../../electron/provider-models'

vi.mock('axios', () => ({ default: { get: vi.fn(), isAxiosError: (e: unknown) => Boolean(e && typeof e === 'object' && 'isAxiosError' in e) } }))
describe('Provider 模型查询', () => {
  beforeEach(() => vi.clearAllMocks())
  it.each([
    ['https://example.com', 'https://example.com/v1/models'],
    ['https://example.com/v1/', 'https://example.com/v1/models'],
    ['http://localhost:1234/api/v1', 'http://localhost:1234/api/v1/models'],
    ['https://example.com/v1/models', 'https://example.com/v1/models'],
  ])('normalizes %s', (base, expected) => expect(modelsEndpoint(base)).toBe(expected))
  it.each(['file:///tmp/key', 'https://user:pass@example.com', 'https://example.com?key=secret'])('rejects unsafe address %s', base => expect(() => modelsEndpoint(base)).toThrow())
  it('uses bounded authenticated request and deduplicates model ids', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { data: [{ id: 'z' }, { id: 'a' }, { id: 'a' }, {}] } })
    expect(await fetchProviderModels('https://example.com/v1', 'test-key')).toEqual(['a', 'z'])
    expect(axios.get).toHaveBeenCalledWith('https://example.com/v1/models', expect.objectContaining({ headers: { Accept: 'application/json', Authorization: 'Bearer test-key' }, timeout: 15000, maxRedirects: 0 }))
  })
  it('does not expose response bodies or secrets on failure', async () => {
    vi.mocked(axios.get).mockRejectedValue({ isAxiosError: true, response: { status: 401, data: 'secret' } })
    await expect(fetchProviderModels('https://example.com')).rejects.toThrow('HTTP 401')
    await expect(fetchProviderModels('https://example.com')).rejects.not.toThrow('secret')
  })
  it.each([{}, { data: [] }, '<html>login</html>'])('rejects unsupported or empty lists', async data => {
    vi.mocked(axios.get).mockResolvedValue({ data })
    await expect(fetchProviderModels('https://example.com')).rejects.toThrow()
  })
})
