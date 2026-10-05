// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LlmReviewSettingsDialog from '../../src/LlmReviewSettingsDialog'
import type { AgentManagerApi, LlmReviewSettingsSummary } from '../../src/shared/manager-api'

const initial: LlmReviewSettingsSummary = {enabled:false,backend:'api',level:'high',hasApiKey:false,retryCount:0,
  timeoutSeconds:30,scheduledRuleAuditEnabled:false,scheduledRuleAuditHours:24,proxyEnabled:false,
  proxyHost:'127.0.0.1',proxyPort:7897,hasProxyPassword:false,ruleAuditState:{status:'idle'}}
let api: Pick<AgentManagerApi,'getLlmReviewSettings'|'updateLlmReviewSettings'|'reviewApprovalRules'|'listLlmReviewModels'|'listApprovalRules'>
beforeEach(()=>{
  api={getLlmReviewSettings:vi.fn(async()=>({...initial})),
    updateLlmReviewSettings:vi.fn(async input=>({...initial,...input,apiKey:undefined,proxyPassword:undefined,hasApiKey:Boolean(input.apiKey)})),
    reviewApprovalRules:vi.fn(async()=>({status:'running' as const,source:'manual' as const})),
    listLlmReviewModels:vi.fn(async()=>['review-a','review-b']),listApprovalRules:vi.fn(async()=>[])}
  window.agentManager=api as AgentManagerApi
})
afterEach(cleanup)
async function open(){render(<LlmReviewSettingsDialog onClose={()=>{}} />);await waitFor(()=>expect(screen.getByRole('button',{name:'保存设置'})).toBeEnabled())}
async function fill(){
  fireEvent.change(screen.getByLabelText('Base URL'),{target:{value:'https://fixture.example/v1'}})
  fireEvent.change(screen.getByLabelText('API Key'),{target:{value:'fixture-key'}})
  fireEvent.click(screen.getByRole('button',{name:'获取模型'}))
  await screen.findByRole('option',{name:'review-a'})
  fireEvent.change(screen.getByLabelText('Model'),{target:{value:'review-a'}})
}
describe('reviewer settings form',()=>{
  it('fetches and selects a model from the current draft without saving first',async()=>{
    await open();await fill()
    expect(api.listLlmReviewModels).toHaveBeenCalledWith(expect.objectContaining({baseUrl:'https://fixture.example/v1',apiKey:'fixture-key',model:undefined}))
    expect(api.updateLlmReviewSettings).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Model')).toHaveValue('review-a')
  })
  it('saves the filled form before auditing instead of using the old empty configuration',async()=>{
    await open();await fill()
    let finish!: (value:LlmReviewSettingsSummary)=>void
    vi.mocked(api.updateLlmReviewSettings).mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    fireEvent.click(screen.getByRole('button',{name:'保存并立即审查'}))
    expect(api.updateLlmReviewSettings).toHaveBeenCalledWith(expect.objectContaining({apiKey:'fixture-key',model:'review-a'}))
    expect(api.reviewApprovalRules).not.toHaveBeenCalled()
    await act(async()=>finish({...initial,model:'review-a',hasApiKey:true}))
    expect(api.reviewApprovalRules).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('API Key')).toHaveValue('')
  })
  it('does not audit or erase the typed key when saving fails',async()=>{
    await open();await fill()
    vi.mocked(api.updateLlmReviewSettings).mockRejectedValue(new Error('保存失败'))
    fireEvent.click(screen.getByRole('button',{name:'保存并立即审查'}))
    await screen.findByText('保存失败')
    expect(api.reviewApprovalRules).not.toHaveBeenCalled()
    expect(screen.getByLabelText('API Key')).toHaveValue('fixture-key')
  })
  it('reuses a saved key without retrieving its value into the form',async()=>{
    vi.mocked(api.getLlmReviewSettings).mockResolvedValue({...initial,baseUrl:'https://fixture.example/v1',model:'review-a',hasApiKey:true})
    await open();fireEvent.click(screen.getByRole('button',{name:'获取模型'}))
    await screen.findByRole('option',{name:'review-b'})
    expect(vi.mocked(api.listLlmReviewModels).mock.calls[0]?.[0]).not.toHaveProperty('apiKey')
    fireEvent.click(screen.getByRole('button',{name:'保存并立即审查'}))
    await waitFor(()=>expect(api.reviewApprovalRules).toHaveBeenCalledOnce())
    expect(vi.mocked(api.updateLlmReviewSettings).mock.calls[0]?.[0]).not.toHaveProperty('apiKey')
  })
  it('keeps manual model input available when the provider has no models endpoint',async()=>{
    vi.mocked(api.listLlmReviewModels).mockRejectedValue(new Error('服务不支持模型列表'))
    await open();fireEvent.click(screen.getByRole('button',{name:'获取模型'}))
    await screen.findByText(/服务不支持模型列表/)
    fireEvent.click(screen.getByRole('button',{name:'手动输入模型'}))
    fireEvent.change(screen.getByLabelText('Model'),{target:{value:'custom-reviewer'}})
    expect(screen.getByLabelText('Model')).toHaveValue('custom-reviewer')
    expect(api.updateLlmReviewSettings).not.toHaveBeenCalled()
  })
  it('shows which required fields are missing before attempting an audit',async()=>{
    await open();fireEvent.click(screen.getByRole('button',{name:'保存并立即审查'}))
    await screen.findByText('开始审查前，请填写或选择：Base URL、API Key、Model')
    expect(api.reviewApprovalRules).not.toHaveBeenCalled()
    expect(api.updateLlmReviewSettings).not.toHaveBeenCalled()
  })
  it('can save and audit CLI settings without API credentials',async()=>{
    await open();fireEvent.change(screen.getByLabelText('审核后端'),{target:{value:'codex-cli'}})
    fireEvent.click(screen.getByRole('button',{name:'保存并立即审查'}))
    await waitFor(()=>expect(api.reviewApprovalRules).toHaveBeenCalledOnce())
    expect(api.updateLlmReviewSettings).toHaveBeenCalledWith(expect.objectContaining({backend:'codex-cli'}))
  })
})
