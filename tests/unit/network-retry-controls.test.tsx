// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import NetworkRetryControls from '../../src/NetworkRetryControls'

afterEach(cleanup)
it('keeps an explicit off distinct from inherited watchdog and clears numbers to inherit', () => {
  const onChange = vi.fn()
  render(<NetworkRetryControls agentKind='claude' value={{ claudeRequestRetries: 10 }} onChange={onChange} />)
  expect(screen.getByLabelText('长重试模式')).toHaveValue('inherit')
  fireEvent.change(screen.getByLabelText('长重试模式'), { target: { value: 'false' } })
  expect(onChange).toHaveBeenLastCalledWith({ claudeRequestRetries: 10, claudeRetryWatchdog: false })
  fireEvent.change(screen.getByLabelText('请求重试次数（0–15）'), { target: { value: '' } })
  expect(onChange).toHaveBeenLastCalledWith({ claudeRequestRetries: undefined })
})
it('limits the count when disabling watchdog and does not show unsupported Agent settings', () => {
  const onChange = vi.fn()
  const view = render(<NetworkRetryControls agentKind='claude' value={{ claudeRetryWatchdog: true, claudeRequestRetries: 300 }} onChange={onChange} />)
  fireEvent.change(screen.getByLabelText('长重试模式'), { target: { value: 'inherit' } })
  expect(onChange).toHaveBeenLastCalledWith({ claudeRetryWatchdog: undefined, claudeRequestRetries: 15 })
  view.rerender(<NetworkRetryControls agentKind='pi' value={{}} onChange={onChange} />)
  expect(screen.queryByText('网络断线重试')).not.toBeInTheDocument()
})
