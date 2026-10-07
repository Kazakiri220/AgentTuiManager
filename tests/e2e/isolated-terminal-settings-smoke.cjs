// Real renderer + preload + settings IPC; synthetic sessions and isolated userData.
const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const root = mkdtempSync(join(require('node:os').tmpdir(), 'agent-tui-terminal-settings-'))
process.env.AGENT_TUI_USER_DATA_DIR = root
app.disableHardwareAcceleration()
const out = resolve('.tmp/terminal-settings-verification'); mkdirSync(out, { recursive: true })
let replays = 0, restarts = 0, capturing = false
const session = { sessionId: 'fixture-session', displayName: '隔离测试 Agent', agentKind: 'codex', workspace: join(root, 'fixture-workspace'),
  status: 'running', activity: 'running', approvalMode: 'manual', userStopRequested: false, recoveryAttempts: 0 }
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, callback) => handle(channel, ({
  'agent-manager:list-sessions': () => [session], 'agent-manager:list-pending-approvals': () => [],
  'agent-manager:terminal-replay': () => { replays++; return { data: 'Isolated terminal fixture\r\n', sequence: 0 } },
  'agent-manager:resize': () => undefined, 'agent-manager:write': () => undefined,
  'agent-manager:restart-session': () => { restarts++ },
})[channel] ?? callback)
const timeout = setTimeout(() => { console.error('Terminal settings smoke timed out'); app.exit(1) }, 40000)
app.on('browser-window-created', (_event, win) => {
  if (capturing) return
  win.hide(); win.on('show', () => win.hide()); win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async()=>{
        const wait=ms=>new Promise(r=>setTimeout(r,ms));
        const until=async test=>{for(let i=0;i<150;i++){if(test())return;await wait(30)}throw Error('UI state timed out')};
        const button=name=>[...document.querySelectorAll('button')].find(e=>!e.closest('[inert]')&&(e.getAttribute('aria-label')===name||e.textContent.trim()===name));
        const click=name=>{const b=button(name);if(!b||b.disabled)throw Error('Missing '+name);b.click()};
        await until(()=>document.querySelector('.xterm'));const terminal=document.querySelector('.xterm');
        const open=async()=>{click('设置');await until(()=>button('终端显示模式'));click('终端显示模式');await until(()=>button('保存设置')&&!button('保存设置').disabled)};
        await open();const select=document.querySelector('#codex-terminal-mode');if(select.value!=='scrollback')throw Error('Default changed');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'native-fullscreen');select.dispatchEvent(new Event('change',{bubbles:true}));await wait(30);
        click('保存设置');await until(()=>!document.querySelector('.terminal-settings-dialog'));await open();await wait(180);
        if(document.querySelector('#codex-terminal-mode').value!=='native-fullscreen')throw Error('Mode not persisted');
        if(!terminal.isConnected||document.querySelector('.xterm')!==terminal)throw Error('Settings remounted terminal');
        const footer=document.querySelector('.terminal-settings-dialog > footer'),dialog=document.querySelector('.terminal-settings-dialog');
        if(footer.getBoundingClientRect().bottom>dialog.getBoundingClientRect().bottom)throw Error('Footer outside dialog');
        return {ok:true,persisted:true,terminalReused:true};
      })()`)
      if (!result.ok || replays !== 1 || restarts !== 0) throw Error('Saving settings disturbed running sessions')
      const stored = JSON.parse(readFileSync(join(root, 'terminal-settings.json'), 'utf8'))
      if (stored.codexMode !== 'native-fullscreen') throw Error('Settings file not persisted')
      const snapshot = await win.webContents.executeJavaScript(`(()=>{
        const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script,link[rel="stylesheet"],meta[http-equiv]').forEach(e=>e.remove());
        clone.querySelectorAll('option').forEach((e,i)=>{if(document.querySelectorAll('option')[i].selected)e.setAttribute('selected','');else e.removeAttribute('selected')});
        return {html:clone.outerHTML,css:[...document.styleSheets].map(s=>[...s.cssRules].map(r=>r.cssText).join('\\n')).join('\\n'),width:innerWidth,height:innerHeight};
      })()`)
      const html = join(out, 'terminal-settings.html')
      writeFileSync(html, snapshot.html.replace('<head>', `<head><base href="${pathToFileURL(resolve('dist-electron/renderer/index.html')).href}"><style>${snapshot.css}*{animation:none!important;transition:none!important}</style>`))
      capturing = true
      const surface = new BrowserWindow({ show: false, width: snapshot.width, height: snapshot.height, webPreferences: { offscreen: true, sandbox: true } })
      capturing = false; await surface.loadFile(html)
      await new Promise(resolve => setTimeout(resolve, 200))
      writeFileSync(join(out, 'terminal-settings.png'), (await surface.webContents.capturePage()).toPNG()); surface.destroy()
      await win.webContents.executeJavaScript(`(async()=>{await window.agentManager.updateTerminalSettings({codexMode:'scrollback'});if((await window.agentManager.getTerminalSettings()).codexMode!=='scrollback')throw Error('Could not restore mode')})()`)
      const final = { ...result, realSettingsIPC: true, replayRequests: replays, runningSessionRestarts: restarts }
      writeFileSync(join(out, 'verification.json'), JSON.stringify(final, null, 2)); console.log(JSON.stringify(final)); clearTimeout(timeout); app.exit(0)
    } catch (error) { console.error(error.message); clearTimeout(timeout); app.exit(1) }
  })
})
require(resolve(process.env.AGENT_TUI_SMOKE_ENTRY || 'dist-electron/main.js'))
