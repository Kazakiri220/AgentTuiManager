# Codex 终端显示模式

版本：0.4.13-local.2。基于 integrate/upstream-0.4.13，默认保持滚动历史模式。

## 使用范围

设置 → 终端显示模式提供“滚动历史模式”和“Codex 原生全屏模式”。全屏指 Codex 占满当前 Agent 面板，不改变 Manager 或面板的尺寸。

设置在主进程持久化，通过受限 IPC 读写。每次启动捕获当时的设置，包括新建、重启、恢复启动和续接。连接回仍然运行的 Host 不改变其显示方式。保存不会主动重启任何会话。其他 CLI 不受影响。

原生全屏模式移除实际启动参数中的 `--no-alt-screen`，并覆盖 `tui.alternate_screen="always"` 与 `tui.fullscreen_transcript=true`。变换仅作用于终端显示选项；原生恢复标识、Hook、Provider、审批与沙箱选项保持原样。规范恢复命令继续沿用原格式，在最终 PTY 启动边界应用当前偏好。

Codex resume 的配置作用域有版本差异：不会为了显示设置首次引入 resume 子命令的 `-c`；调用者已使用该作用域时，同样在该作用域末尾覆盖显示设置。`--` 后的提示词及选项值不作为终端选项处理。

## 输入和历史

- 鼠标事件仍交由 xterm.js 发送给官方 CLI；不解析或复制一份私有输入编辑器。
- Codex 0.159.2 的底部输入支持点击定位、拖选、输入替换选区、Delete 删除选区和粘贴。Ctrl+C 的选区复制由 Codex 原生处理；无选区时仍可能中断。Shift 拖选走 xterm 的显示文字选择。
- **该版本不支持 Ctrl+X 剪切鼠标选区。** 本次没有添加通过猜测选区、模拟删除实现的剪切功能。
- 原生全屏模式的历史滚动由 Codex 管理。Manager 的普通缓冲区滚动锁不再干预备用屏幕。
- 既有终端复用、分批回放、输出顺序、窗口切换和历史索引缓存保留；没有新增轮询或额外终端实例。
- SerializeAddon 原先遗漏鼠标坐标编码。现在从原始 PTY 的已解析控制序列记录 SGR/像素鼠标编码，并在快照中恢复，支持跨块控制序列、关闭编码和终端复位。

## 验证

- TypeScript 检查和生产编译通过。
- Windows x64 NSIS 安装器封装成功：`release/Agent-TUI-Manager-Setup-0.4.13-local.2-x64.exe`。未执行安装器或替换正在使用的应用。
- 完整回归：110 个测试文件，1492 项通过、2 项原有可选测试跳过。
- 新增设置校验/持久化/失败写入、对话框错误与焦点、启动时捕获最新设置、既有 Host 不变、恢复标识不变、参数作用域、提示词边界，以及全屏回放/鼠标编码/滚动隔离测试。
- `tests/e2e/isolated-terminal-settings-smoke.cjs`：真实 Electron 渲染、preload 和设置 IPC；保存/重开/还原设置成功，终端节点复用，回放 1 次，运行中会话重启 0 次。标题和底栏固定，内容可滚动，复用统一动效。
- Windows 隔离 Codex 0.159.2 + ConPTY + xterm 实测：点击定位、拖选替换、删除选区、括号粘贴均通过；Ctrl+X 未剪切，与源码一致。测试只使用空工作区、临时 CODEX_HOME、无认证本地 Provider，不发送任务，不访问真实会话或密钥，不读取或改写系统剪贴板。
- 未对用户的长会话做新模式性能基准，也未实测系统剪贴板复制；相关 CLI 行为以对应版本源码为依据。已有长历史回放及切换复用回归通过。

参考：[Codex 0.159.2 composer mouse](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/tui/src/bottom_pane/chat_composer/mouse.rs)、[textarea mouse](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/tui/src/bottom_pane/textarea/mouse.rs)、[clipboard backend](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/tui/src/clipboard_copy.rs)。
