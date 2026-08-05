import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as msal from '@azure/msal-node'
import { Activity } from '@microsoft/agents-activity'
import {
  AgentType,
  ConnectionSettings,
  CopilotStudioClient,
  PowerPlatformCloud
} from '@microsoft/agents-copilotstudio-client'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, 'public')
const port = Number(process.env.PORT || 3102)
const directLineBase = 'https://directline.botframework.com/v3/directline'
const directLineSecret = process.env.DIRECTLINE_SECRET?.trim()
const tokenEndpoint = process.env.COPILOT_TOKEN_ENDPOINT?.trim()
const cacheFile = path.join(__dirname, '.cache', 'msal-cache.json')

const d2eConfigured = Boolean(
  process.env.APP_CLIENT_ID?.trim() && process.env.TENANT_ID?.trim()
  && process.env.ENVIRONMENT_ID?.trim() && process.env.AGENT_SCHEMA_NAME?.trim()
)
const d2eSettings = d2eConfigured ? new ConnectionSettings({
  environmentId: process.env.ENVIRONMENT_ID,
  schemaName: process.env.AGENT_SCHEMA_NAME,
  cloud: PowerPlatformCloud.Prod,
  copilotAgentType: AgentType.Published,
  useExperimentalEndpoint: true
}) : null

const cachePlugin = {
  beforeCacheAccess: async context => {
    if (fs.existsSync(cacheFile)) {
      context.tokenCache.deserialize(fs.readFileSync(cacheFile, 'utf8'))
    }
  },
  afterCacheAccess: async context => {
    if (context.cacheHasChanged) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      fs.writeFileSync(cacheFile, context.tokenCache.serialize())
    }
  }
}
const publicClient = d2eConfigured ? new msal.PublicClientApplication({
  auth: {
    clientId: process.env.APP_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`
  },
  cache: { cachePlugin }
}) : null
let d2eClientPromise

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(JSON.stringify(body))
}

function serve(res, filename, contentType) {
  const file = path.join(publicDir, filename)
  if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found' })
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  fs.createReadStream(file).pipe(res)
}

async function readBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function acquireDirectLineToken(origin) {
  if (tokenEndpoint) {
    const response = await fetch(tokenEndpoint)
    if (!response.ok) throw new Error(`Token endpoint returned HTTP ${response.status}`)
    const data = await response.json()
    if (!data.token) throw new Error('Token endpoint did not return token')
    return { ...data, source: 'copilot-token-endpoint' }
  }
  if (!directLineSecret) throw new Error('Set DIRECTLINE_SECRET or COPILOT_TOKEN_ENDPOINT')

  const userId = `dl_${crypto.randomUUID()}`
  const response = await fetch(`${directLineBase}/tokens/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${directLineSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: { id: userId, name: 'Streaming demo user' },
      trustedOrigins: [origin]
    })
  })
  if (!response.ok) throw new Error(`Direct Line token generation returned HTTP ${response.status}`)
  return { ...(await response.json()), userId, source: 'direct-line-secret' }
}

async function startDirectLineConversation(token) {
  const response = await fetch(`${directLineBase}/conversations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!response.ok) throw new Error(`Starting Direct Line conversation returned HTTP ${response.status}`)
  return response.json()
}

async function createD2EClient() {
  if (!d2eConfigured) throw new Error('D2E configuration is incomplete')
  const accounts = await publicClient.getAllAccounts()
  if (!accounts.length) throw new Error('Run npm run d2e:login before using D2E mode')
  const scope = CopilotStudioClient.scopeFromSettings(d2eSettings)
  const auth = await publicClient.acquireTokenSilent({ account: accounts[0], scopes: [scope] })
  if (!auth?.accessToken) throw new Error('Entra did not return a delegated D2E token')

  const client = new CopilotStudioClient(d2eSettings, auth.accessToken)
  for await (const _activity of client.startConversationStreaming({
    emitStartConversationEvent: false,
    locale: 'en-US'
  })) {
    // Drain startup activities before accepting prompts.
  }
  return client
}

function getD2EClient() {
  d2eClientPromise ??= createD2EClient()
  return d2eClientPromise
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${port}`}`)

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serve(res, 'index.html', 'text/html; charset=utf-8')
    }
    if (req.method === 'GET' && url.pathname === '/streaming.css') {
      return serve(res, 'streaming.css', 'text/css; charset=utf-8')
    }
    if (req.method === 'GET' && url.pathname === '/streaming.js') {
      return serve(res, 'streaming.js', 'text/javascript; charset=utf-8')
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, {
        directLineConfigured: Boolean(tokenEndpoint || directLineSecret),
        d2eConfigured,
        secretExposed: false
      })
    }
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/directline/token') {
      const token = await acquireDirectLineToken(req.headers.origin || `http://localhost:${port}`)
      return json(res, 200, {
        token: token.token,
        conversationId: token.conversationId,
        expiresIn: token.expires_in,
        userId: token.userId || `dl_${crypto.randomUUID()}`,
        source: token.source,
        domain: directLineBase
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/test-connection') {
      const startedAt = Date.now()
      const token = await acquireDirectLineToken(`http://localhost:${port}`)
      const conversation = await startDirectLineConversation(token.token)
      return json(res, 200, {
        ok: true,
        tokenAcquired: true,
        conversationId: conversation.conversationId,
        webSocketStreamUrl: Boolean(conversation.streamUrl),
        elapsedMs: Date.now() - startedAt
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/d2e/status') {
      return json(res, 200, {
        configured: d2eConfigured,
        authentication: 'delegated-user-cache',
        transport: 'direct-to-engine-sse'
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/d2e/reset') {
      d2eClientPromise = undefined
      await getD2EClient()
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/d2e/send') {
      const input = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      if (!input.text?.trim()) return json(res, 400, { error: 'text is required' })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      try {
        const client = await getD2EClient()
        const outgoing = Activity.fromObject({ type: 'message', text: input.text.trim() })
        for await (const activity of client.sendActivityStreaming(outgoing)) {
          res.write(`data: ${JSON.stringify(activity)}\n\n`)
        }
        res.write('event: done\ndata: {}\n\n')
      } catch (error) {
        d2eClientPromise = undefined
        res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`)
      }
      return res.end()
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok' })

    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    console.error(error)
    return json(res, 500, { error: error.message })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Copilot Studio Streaming Toolkit: http://localhost:${port}`)
  console.log('Secrets remain server-side; browser receives short-lived tokens only.')
})
