import axios from 'axios'

export function modelsEndpoint(baseUrl: string): string {
  let url: URL
  try { url = new URL(baseUrl.trim()) } catch { throw new Error('请输入有效的 Base URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 必须是无账号、查询参数的 HTTP(S) 地址')
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/models') ? path : `${path || '/v1'}/models`
  return url.toString()
}

export async function fetchProviderModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const endpoint = modelsEndpoint(baseUrl)
  let data: unknown
  try {
    const response = await axios.get(endpoint, {
      headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      timeout: 15000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024,
    })
    data = response.data
  } catch (error) {
    // 不转发服务端响应或 axios 配置，避免泄露密钥。
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    throw new Error(status ? `获取模型失败（HTTP ${status}），请检查地址、密钥及 /models 接口支持情况` : '获取模型失败：连接失败或超时，请检查地址和网络')
  }
  if (!data || typeof data !== 'object' || !Array.isArray((data as { data?: unknown }).data)) throw new Error('接口未返回 OpenAI 兼容的模型列表（data 数组）')
  const models = [...new Set(((data as { data: unknown[] }).data).flatMap(item => {
    const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined
    return typeof id === 'string' && id.trim() && id.length <= 512 ? [id.trim()] : []
  }))].sort()
  if (!models.length) throw new Error('接口没有返回可选模型，可继续手动填写')
  return models
}
