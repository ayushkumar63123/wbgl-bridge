import http from 'http'
import app from './app.js'
import {port} from './utils/config.js'
import {Db, Chores} from './modules/index.js'

const server = http.createServer(app)
server.listen(parseInt(port), () => {
  console.log(`listening on *:${port}`)
})

process.on('uncaughtException', async error => {
  console.log('UNCAUGHT EXCEPTION:', error)
  await Db.close()
  process.exit(1)
})

await Db.init()
await Chores.init()
