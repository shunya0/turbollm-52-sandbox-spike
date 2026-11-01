// Helper for experiment 3: a stand-in for the daemon on 127.0.0.1:6996 that prints any request it receives.
// Runs in plain Node (outside the sandbox) and exits after 60 s. Start it first, in its own terminal.
//
//   node 3-listener.mjs
import { createServer } from 'node:http'

const s = createServer((req, res) => { console.log('RECEIVED', req.method, req.url); res.writeHead(201); res.end('{}') })
s.listen(6996, '127.0.0.1', () => console.log('listening on 127.0.0.1:6996 for 60 s'))
setTimeout(() => { console.log('done'); process.exit(0) }, 60_000)
