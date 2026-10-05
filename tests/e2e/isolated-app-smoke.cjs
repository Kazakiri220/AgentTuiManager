// Boot the actual built main/preload/renderer with empty isolated app data.
const { app, shell } = require('electron')
let soundCalls = 0
const nativeSoundAvailable = typeof shell.beep === 'function'
shell.beep = () => { soundCalls += 1 }
const { mkdtempSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const root = mkdtempSync(join(tmpdir(), 'agent-tui-app-smoke-'))
process.env.AGENT_TUI_USER_DATA_DIR = root
const timer = setTimeout(() => { console.error('App smoke timed out'); app.exit(1) }, 25000)
process.on('unhandledRejection', error => { console.error(error); app.exit(1) })
app.on('browser-window-created', (_event, win) => {
  win.hide()
  win.on('show', () => win.hide())
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const api=window.agentManager;
        if(!api || typeof api.setApprovalMode!=='function')throw Error('Missing mode IPC');
        if(typeof api.setActiveSession!=='function')throw Error('Missing active Agent IPC');
        if(typeof api.listLlmReviewModels!=='function')throw Error('Missing model catalog IPC');
        if(typeof api.testAttentionSound!=='function')throw Error('Missing audio test IPC');
        let tones=0; let testContext;
        window.AudioContext=function(){return testContext={state:'running',currentTime:0,destination:{},createOscillator(){return {frequency:{value:0},connect(){},disconnect(){},start(){tones++},stop(){}}},createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}}}}};
        await new Promise(resolve=>setTimeout(resolve,250));
        await api.testAttentionSound();
        await new Promise(resolve=>setTimeout(resolve,100));
        if(tones!==2)throw Error('Renderer did not receive the two-tone chime');
        testContext.state='closed';
        window.AudioContext=function(){throw Error('Mock output device unavailable')};
        await api.testAttentionSound();
        await new Promise(resolve=>setTimeout(resolve,100));
        await api.setActiveSession(null);
        await api.setActiveSession('missing-session');
        const invalidActive=await api.setActiveSession({id:'bad'}).then(()=>false,()=>true);
        if(!invalidActive)throw Error('Invalid active Agent accepted');
        const sessions=await api.listSessions();
        if(sessions.length)throw Error('Smoke environment is not isolated');
        const settings=await api.getLlmReviewSettings();
        if(settings.enabled)throw Error('Unexpected reviewer configured');
        await api.updateLlmReviewSettings({...settings,enabled:false,backend:'codex-cli'});
        const updated=await api.getLlmReviewSettings();
        if(updated.backend!=='codex-cli')throw Error('Reviewer settings did not roundtrip');
        const invalid=await api.setApprovalMode('missing-session','invalid-mode').then(()=>false,()=>true);
        if(!invalid)throw Error('Invalid mode accepted');
        return {sessions:sessions.length,modeIpc:true,activeAgentIpc:true,backend:updated.backend,audioTones:tones,modelCatalogIpc:true};
      })()`)
      if (!nativeSoundAvailable || soundCalls!==1) throw Error('Audio fallback did not run exactly once')
      console.log(JSON.stringify({ok:true,userData:app.getPath('userData'),nativeSoundAvailable,soundCalls,...result}))
      clearTimeout(timer); app.exit(0)
    } catch(error) { console.error(error); clearTimeout(timer); app.exit(1) }
  })
})
require(resolve(process.env.AGENT_TUI_SMOKE_ENTRY || 'dist-electron/main.js'))
