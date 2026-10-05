/** Extraction for the hook transport. The original toolInput is always retained. */
const MAX_COMMAND_LENGTH = 16_384
const MAX_PATH_LENGTH = 4_096
const MAX_TARGET_PATHS = 100

export function boundedHookText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0')
    ? value
    : undefined
}

function firstField(details: Record<string, unknown> | undefined, names: string[]): unknown {
  if (!details) return undefined
  const name = names.find((name) => Object.prototype.hasOwnProperty.call(details, name))
  return name ? details[name] : undefined
}

export function permissionHookFields(details: Record<string, unknown> | undefined): {
  command?: string
  filePath?: string
  targetPaths?: string[]
  inputTruncated?: true
} {
  let inputTruncated = false
  let command: string | undefined
  const rawCommand = firstField(details, ['command', 'cmd', 'script'])
  if (Array.isArray(rawCommand)) {
    if (!rawCommand.length || rawCommand.some((part) => typeof part !== 'string' || part.includes('\0'))
      || !rawCommand[0]?.trim()) inputTruncated = true
    else {
      // Do not join argv into a shell string: quoted/multiline argument boundaries matter.
      // This matches the local assessment's static representation length limit.
      const length = rawCommand.map((part: string) => "'" + part.replace(/'/g, "''") + "'").join(' ').length
      if (length > MAX_COMMAND_LENGTH) inputTruncated = true
    }
  } else if (rawCommand !== undefined) {
    command = boundedHookText(rawCommand, MAX_COMMAND_LENGTH)
    if (!command?.trim()) { command = undefined; inputTruncated = true }
  }
  const rawFilePath = firstField(details, ['file_path', 'notebook_path', 'path'])
  const filePath = boundedHookText(rawFilePath, MAX_PATH_LENGTH)
  if (rawFilePath !== undefined && !filePath) inputTruncated = true
  const rawPaths = firstField(details, ['file_paths', 'paths'])
  let targetPaths: string[] | undefined
  if (rawPaths !== undefined) {
    if (!Array.isArray(rawPaths) || rawPaths.length > MAX_TARGET_PATHS
      || rawPaths.some((path) => !boundedHookText(path, MAX_PATH_LENGTH))) inputTruncated = true
    else targetPaths = [...rawPaths] as string[]
  }
  return {
    ...(command !== undefined ? { command } : {}),
    ...(filePath ? { filePath } : {}),
    ...(targetPaths?.length ? { targetPaths } : {}),
    ...(inputTruncated ? { inputTruncated: true } : {}),
  }
}
