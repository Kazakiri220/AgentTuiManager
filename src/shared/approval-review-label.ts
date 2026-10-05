import type { ApprovalRequest } from './manager-api'

/** Describes a still-pending request; model approval and command execution are separate states. */
export function approvalReviewLabel(request?: ApprovalRequest): string {
  if (request?.llmReviewStatus === 'pending') return 'LLM 正在审核'
  if (request?.llmReviewStatus === 'failed') return '审核失败，正在拒绝本次请求'
  if (request?.llmReviewStatus === 'completed') {
    if (request.llmReviewError) return '审核已完成，处理失败'
    if (request.llmReview?.verdict === 'deny') return '审核建议拒绝，等待处理'
    if (request.llmReview?.verdict === 'allow' && !request.llmReview.requiresHumanApproval) return '审核已批准，等待处理'
    return '审核未明确批准，正在拒绝本次请求'
  }
  return 'Agent 正在等待授权'
}
