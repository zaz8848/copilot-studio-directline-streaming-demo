import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as msal from '@azure/msal-node'
import {
  AgentType,
  ConnectionSettings,
  CopilotStudioClient,
  PowerPlatformCloud
} from '@microsoft/agents-copilotstudio-client'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cacheFile = path.join(__dirname, '..', '.cache', 'msal-cache.json')
const required = ['APP_CLIENT_ID', 'TENANT_ID', 'ENVIRONMENT_ID', 'AGENT_SCHEMA_NAME']
const missing = required.filter(name => !process.env[name]?.trim())
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`)

const settings = new ConnectionSettings({
  environmentId: process.env.ENVIRONMENT_ID,
  schemaName: process.env.AGENT_SCHEMA_NAME,
  cloud: PowerPlatformCloud.Prod,
  copilotAgentType: AgentType.Published,
  useExperimentalEndpoint: true
})

const cachePlugin = {
  beforeCacheAccess: async context => {
    if (fs.existsSync(cacheFile)) context.tokenCache.deserialize(fs.readFileSync(cacheFile, 'utf8'))
  },
  afterCacheAccess: async context => {
    if (context.cacheHasChanged) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      fs.writeFileSync(cacheFile, context.tokenCache.serialize())
    }
  }
}
const client = new msal.PublicClientApplication({
  auth: {
    clientId: process.env.APP_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`
  },
  cache: { cachePlugin }
})
const scopes = [CopilotStudioClient.scopeFromSettings(settings)]
const accounts = await client.getAllAccounts()
let result
if (accounts.length) {
  try {
    result = await client.acquireTokenSilent({ account: accounts[0], scopes })
  } catch {
    // Fall through to device login.
  }
}
result ??= await client.acquireTokenByDeviceCode({
  scopes,
  deviceCodeCallback: response => console.log(`\n${response.message}\n`)
})
if (!result?.accessToken) throw new Error('Microsoft Entra did not return an access token')
console.log('D2E delegated login succeeded. Local token cache is ready.')
