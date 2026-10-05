// 诊断夹具：本地连接可用，但模拟 PTY 冷启动超过默认 5 秒。
const net = require('node:net')
const args = process.argv.slice(2)
const endpoint = args[args.indexOf('--endpoint') + 1]
const hostId = args[args.indexOf('--host-id') + 1]
const server = net.createServer(socket => {
  socket.on('close', () => server.close())
  let buffer = ''
  socket.on('error', () => {})
  socket.on('data', chunk => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const command = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (command.type === 'start') setTimeout(() => {
        if (!socket.destroyed) socket.write(JSON.stringify({ type: 'ready', hostId }) + '\n')
      }, 5200)
      if (command.type === 'ping') socket.write(JSON.stringify({ type: 'pong', ownership: 'managed' }) + '\n')
    }
  })
})
server.listen(endpoint)
