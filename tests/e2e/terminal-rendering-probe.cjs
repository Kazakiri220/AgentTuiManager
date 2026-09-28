// 有界、隔离的真实 Chromium/xterm 探针，不接入 PTY、账号或在线会话。
const { app, BrowserWindow } = require('electron')
const { build } = require('esbuild')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

app.whenReady().then(async () => {
  let win
  try {
    const bundle = await build({
      stdin: { contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {Terminal} from '@xterm/xterm';
        import TerminalTile from './src/TerminalTile';
        const open = Terminal.prototype.open;
        Terminal.prototype.open = function(host) {
          window.probeTerminal=this;
          const result=open.call(this, host);
          return result;
        };
        const listeners = new Set();
        window.probeSizes=[];
        window.agentManager={
          subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
          terminalReplay: async () => { await new Promise(r=>setTimeout(r,350)); return {data:'old screen',sequence:0}; },
          resize: async (id,cols,rows) => window.probeSizes.push({cols,rows}),
          write: async () => {}, readClipboardText: async () => '',
        };
        window.probeOutput=data=>listeners.forEach(fn=>fn({type:'output',sessionId:'probe',data}));
        createRoot(document.getElementById('root')).render(<TerminalTile session={{
          sessionId:'probe', displayName:'Synthetic terminal', agentKind:'codex',
          workspace:'demo', status:'running', recoveryAttempts:0, userStopRequested:false
        }}/>);
      `, resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true, write: false, platform: 'browser', format: 'iife',
      loader: { '.png': 'dataurl', '.svg': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    win = new BrowserWindow({ show: false, width: 900, height: 640,
      webPreferences: { partition: 'terminal-render-probe', sandbox: true, backgroundThrottling: false } })
    const css = readFileSync(resolve('node_modules/@xterm/xterm/css/xterm.css'), 'utf8')
      + readFileSync(resolve('src/styles.css'), 'utf8')
    await win.loadURL('data:text/html,' + encodeURIComponent('<div id="root"></div><style>' + css
      + '#root{width:780px;height:500px}.terminal-card{height:500px;display:flex;flex-direction:column}</style>'))
    await win.webContents.executeJavaScript(bundle.outputFiles[0].text)
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      await wait(1800);
      // 隐藏的 Chromium 可能把写入完成推迟到有界看门狗触发；
      // 等待实际事件序列，不假设固定的帧延迟。
      for(let elapsed=0;window.probeSizes.length<1 && elapsed<6000;elapsed+=100) await wait(100);
      const initialSizes=window.probeSizes.slice();
      if(initialSizes.length!==1) {
        throw new Error('Unexpected automatic redraw: '+JSON.stringify(initialSizes));
      }
      const term=window.probeTerminal;
      const host=document.querySelector('.terminal-live-host');
      const surface=document.querySelector('.terminal-surface');
      const metrics=()=>({cols:term.cols,rows:term.rows,base:term.buffer.active.baseY,
        viewport:term.buffer.active.viewportY,hostScroll:host.scrollTop,surfaceScroll:surface.scrollTop,
        screenTop:document.querySelector('.xterm-screen').getBoundingClientRect().top,
        sizes:window.probeSizes.length});
      window.probeOutput(Array.from({length:400},(_,i)=>'line '+i+'\\r\\n').join(''));
      await wait(300);
      const before=metrics();
      term.focus();
      const samples=[];
      for(let i=0;i<40;i++){
        term.input('a',true);
        window.probeOutput('\\r\\x1b[2K> '+ 'a'.repeat(i+1));
        await wait(20);
        samples.push(metrics());
      }
      const after=metrics();
      const switches=[];
      const root=document.getElementById('root');
      for(let i=0;i<12;i++){
        root.style.display='none';
        await wait(60);
        window.probeOutput('\\r\\x1b[2KPAGE-'+i);
        await wait(60);
        root.style.display='';
        await wait(300);
        switches.push({...metrics(),visibleText:host.querySelector('.xterm-rows')?.textContent?.slice(-100)});
      }
      return {initialSizes,before,after,switches,distinctHostScroll:[...new Set(samples.map(s=>s.hostScroll))],
        distinctScreenTop:[...new Set(samples.map(s=>s.screenTop))],
        offBottom:samples.filter(s=>s.base!==s.viewport).length};
    })()`)
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    win?.destroy()
    app.exit(process.exitCode || 0)
  }
})
