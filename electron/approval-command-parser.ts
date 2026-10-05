/** Static inspection only: this module never starts a shell or evaluates source. */
export interface CommandToken {
  value: string
  raw: string
}

export interface ParsedApprovalCommand {
  /** Quoted arguments remain data unless passed to a known inline interpreter. */
  commands: string[]
  redirections: string[]
  code: Array<{ language: 'python' | 'javascript'; source: string }>
  incomplete?: string
}

function executableName(value: string): string {
  const name = value.replace(/^.*[/\\]/, '').replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase()
  return /\s/.test(name) ? '<literal-command-name>' : name
}

function tokenize(source: string): { statements: Array<{ tokens: CommandToken[]; piped: boolean }>; incomplete?: string } {
  const statements: Array<{ tokens: CommandToken[]; piped: boolean }> = []
  let tokens: CommandToken[] = []
  let piped = false
  let pendingPipe = false
  const delimiters: string[] = []
  let index = 0
  const flush = () => { if (tokens.length) statements.push({ tokens, piped }); tokens = [] }
  while (index < source.length) {
    const character = source[index]!
    if (character === '\r' || character === '\n' || /[;|&(){}]/.test(character)) {
      flush()
      if (character === '(' || character === '{') delimiters.push(character)
      if (character === ')' || character === '}') {
        if (delimiters.pop() !== (character === ')' ? '(' : '{')) return { statements, incomplete: 'unbalanced-command-delimiter' }
      }
      if (character === '|') {
        piped = source[index + 1] !== '|' && source[index - 1] !== '|'
        pendingPipe = true
      } else if (character !== '\r' && character !== '\n') piped = false
      index++
      continue
    }
    if (/\s/.test(character)) { index++; continue }
    if (source.startsWith('<#', index)) {
      const end = source.indexOf('#>', index + 2)
      if (end < 0) return { statements, incomplete: 'unterminated-comment' }
      index = end + 2
      continue
    }
    if (character === '#') {
      index = source.indexOf('\n', index)
      if (index < 0) break
      continue
    }
    const start = index
    let value = ''
    while (index < source.length && !/[\s;|&(){}]/.test(source[index]!)) {
      if (source[index] === '`' && index + 1 < source.length) {
        if (source[index + 1] !== '\r' && source[index + 1] !== '\n') value += source[index + 1]
        index += source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2
        continue
      }
      if (source[index] === '\\' && /[\r\n]/.test(source[index + 1] ?? '')) {
        index += source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2
        continue
      }
      const hereString = source[index] === '@' && /['"]/.test(source[index + 1] ?? '')
        && /[\r\n]/.test(source[index + 2] ?? '')
      if (hereString) {
        const quote = source[index + 1]
        const bodyStart = index + (source[index + 2] === '\r' ? 4 : 3)
        const ending = new RegExp('(?:^|\\r?\\n)' + quote + '@(?=\\s|$)', 'g')
        ending.lastIndex = bodyStart
        const match = ending.exec(source)
        if (!match) return { statements, incomplete: 'unterminated-here-string' }
        value += source.slice(bodyStart, match.index)
        index = match.index + match[0].length
        continue
      }
      if (source[index] === '"' || source[index] === "'") {
        const quote = source[index++]
        let closed = false
        while (index < source.length) {
          if (source[index] === quote) {
            if (source[index + 1] === quote) { value += quote; index += 2; continue }
            index++; closed = true; break
          }
          if (quote === '"' && (source[index] === '`'
            || (source[index] === '\\' && /["\\$`]/.test(source[index + 1] ?? ''))) && index + 1 < source.length) {
            value += source[++index]; index++; continue
          }
          value += source[index++]
        }
        if (!closed) return { statements, incomplete: 'unterminated-quote' }
        continue
      }
      if (source[index] === '>') {
        if (value) break
        while (source[index] === '>') value += source[index++]
        break
      }
      value += source[index++]
    }
    if (value) tokens.push({ value, raw: source.slice(start, index) })
    pendingPipe = false
  }
  flush()
  if (delimiters.length) return { statements, incomplete: 'unbalanced-command-delimiter' }
  if (pendingPipe) return { statements, incomplete: 'missing-pipeline-command' }
  return { statements }
}

function decodePowerShell(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return undefined
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length % 2 || bytes.toString('base64') !== value) return undefined
  const decoded = bytes.toString('utf16le')
  return decoded.trim() && !decoded.includes('\0') ? decoded : undefined
}

export function parseApprovalCommand(source: string): ParsedApprovalCommand {
  const result: ParsedApprovalCommand = { commands: [], redirections: [], code: [] }
  let inspectedLength = 0
  function inspect(script: string, depth: number): void {
    inspectedLength += script.length
    if (depth > 8 || inspectedLength > 131_072) { result.incomplete = 'nested-command-limit'; return }
    const heredocs = new Map<string, string>()
    script = script.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\r\n]*\r?\n([\s\S]*?)\r?\n\2(?=\r?\n|$)/g,
      (_match, _quote: string, _delimiter: string, body: string) => {
        const id = '__approval_heredoc_' + heredocs.size + '__'
        heredocs.set(id, body)
        return id + '\n'
      })
    const parsed = tokenize(script)
    if (parsed.incomplete) result.incomplete = parsed.incomplete
    for (const statement of parsed.statements) {
      let tokens = statement.tokens
      while (tokens.length && /^[A-Za-z_]\w*=/.test(tokens[0]!.value)) tokens = tokens.slice(1)
      if (/^\$[\w:]+$/.test(tokens[0]?.value ?? '') && tokens[1]?.value === '=') tokens = tokens.slice(2)
      if (tokens[0]?.value === '$') tokens = tokens.slice(1)
      if (!tokens.length) continue
      const name = executableName(tokens[0]!.value)
      const args = tokens.slice(1)
      if (args.some((arg) => /^<<-?(?:[A-Za-z_'\"]|$)/.test(arg.raw))) result.incomplete = 'unterminated-heredoc'
      let commandArgs = args
      if (name === 'git') {
        while (commandArgs.length && /^(?:-[Cc]|--git-dir|--work-tree)$/.test(commandArgs[0]!.value)) commandArgs = commandArgs.slice(2)
        while (commandArgs.length && /^--(?:git-dir|work-tree)=/.test(commandArgs[0]!.value)) commandArgs = commandArgs.slice(1)
      }
      result.commands.push([name, ...commandArgs.map((token) => token.value)].join(' '))
      for (let index = 0; index < args.length - 1; index++) {
        if (/^>{1,2}$/.test(args[index]!.raw)) result.redirections.push(args[index]!.value + ' ' + args[index + 1]!.value)
      }
      if (statement.piped) result.commands.push('| ' + name)
      if (/^(?:env|command|nohup|exec|time)$/.test(name) && args.length) {
        if (name === 'command' && args.some((arg) => /^-[vV]$/.test(arg.value))) continue
        let executable = 0
        while (executable < args.length) {
          const argument = args[executable]!.value
          if ((name === 'env' && /^(?:-u|--unset)$/.test(argument)) || (name === 'exec' && argument === '-a')) executable += 2
          else if (argument.startsWith('-') || /^[A-Za-z_]\w*=/.test(argument)) executable++
          else break
        }
        if (executable < args.length) inspect(args.slice(executable).map((token) => token.raw).join(' '), depth + 1)
      } else if (name === 'cmd') {
        const flag = args.findIndex((token) => /^\/[ck]$/i.test(token.value))
        if (flag >= 0) {
          const body = args.slice(flag + 1)
          if (!body.length) result.incomplete = 'missing-shell-command'
          else inspect(body.length === 1 ? body[0]!.value : body.map((token) => token.raw).join(' '), depth + 1)
        }
      } else if (/^(?:pwsh|powershell)$/.test(name)) {
        const flag = args.findIndex((token) => /^-(?:c|command|commandwithargs|e|ec|enc|encodedcommand)$/i.test(token.value))
        if (flag >= 0) {
          const body = args.slice(flag + 1)
          if (/^-(?:e|ec|enc|encodedcommand)$/i.test(args[flag]!.value)) {
            const decoded = body[0] ? decodePowerShell(body[0]!.value) : undefined
            if (decoded) inspect(decoded, depth + 1)
            else result.incomplete = 'invalid-encoded-command'
          } else if (!body.length) result.incomplete = 'missing-shell-command'
          else inspect(body.length === 1 ? body[0]!.value : body.map((token) => token.raw).join(' '), depth + 1)
        }
      } else if (/^(?:bash|sh|zsh|dash)$/.test(name)) {
        const flag = args.findIndex((token) => /^-[a-z]*c[a-z]*$/i.test(token.value))
        if (flag >= 0 && args[flag + 1]) inspect(args[flag + 1]!.value, depth + 1)
      } else if (/^(?:python(?:\d+(?:\.\d+)*)?|py|node|nodejs)$/.test(name)) {
        const language = /^(?:node|nodejs)$/.test(name) ? 'javascript' : 'python'
        const flag = args.findIndex((token) => language === 'python' ? token.value === '-c' : /^(?:-e|--eval|-p|--print)$/.test(token.value))
        if (flag >= 0 && args[flag + 1]) result.code.push({ language, source: args[flag + 1]!.value })
        for (const arg of args) {
          const body = heredocs.get(arg.value)
          if (body !== undefined) result.code.push({ language, source: body })
        }
      }
    }
    if (parsed.statements.filter((statement) => statement.tokens[0]?.value === ':').length >= 4
      && /(?:^|\n)\s*:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(script)) result.commands.push(':(){ :|:& };:')
  }
  inspect(source, 0)
  return result
}

/** Remove comments and string literals, retaining positions and line breaks. */
export function executableCode(source: string, language: 'python' | 'javascript'): string {
  const pattern = language === 'python'
    ? /#[^\r\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"/g
    : /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g
  return source.replace(pattern, (match) => match.replace(/[^\r\n]/g, ' '))
}
