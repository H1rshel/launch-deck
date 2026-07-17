// Reproduce the tablet startup crash: load the production dist with an
// Android UA and capture errors with full stacks.
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, extname } from 'path'

const DIST = 'c:/Users/ohirs/OneDrive/Documents/Visual Studio Projects/launch-deck/dist'
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.json': 'application/json', '.woff2': 'font/woff2' }

const server = createServer((req, res) => {
  let p = req.url.split('?')[0]
  if (p === '/') p = '/index.html'
  let file = join(DIST, p)
  if (!existsSync(file)) file = join(DIST, 'index.html')
  try {
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream')
    res.end(readFileSync(file))
  } catch {
    res.statusCode = 404
    res.end()
  }
})
await new Promise((r) => server.listen(4199, r))

const browser = await chromium.launch()
const page = await browser.newPage({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
})

const errors = []
page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}\n${err.stack || ''}`))
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`CONSOLE: ${msg.text()}`)
})

await page.goto('http://localhost:4199/', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(4000)

const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300))
console.log('=== PAGE TEXT ===')
console.log(bodyText)
console.log('=== ERRORS (' + errors.length + ') ===')
for (const e of errors.slice(0, 5)) console.log(e.slice(0, 1500), '\n---')

await browser.close()
server.close()
process.exit(0)
