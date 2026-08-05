# Copilot Studio Streaming Toolkit

A standalone, MIT-licensed toolkit for testing **real server-side streaming** with Microsoft Copilot Studio.

It includes:

- **Direct Line WebSocket streaming** with `deliveryMode: "stream"` opt-in;
- **Direct-to-Engine (D2E) native SSE streaming** with delegated Microsoft Entra authentication;
- one growing response bubble keyed by `streamId`;
- an activity inspector for `informative → streaming → final` events;
- a practical **PAC CLI agent cloning runbook**.

This is not a typewriter animation. The inspector validates the original livestream metadata emitted by Copilot Studio.

## Streaming modes

| Mode | Transport | Authentication | Server streaming |
|---|---|---|---|
| Direct Line | WebSocket | Server-side secret/token endpoint, or local browser credential | Requires client opt-in and server capability |
| D2E | SSE | Delegated Entra user token cached locally | Native `sendActivityStreaming()` |

## Security model

The recommended Direct Line flow is:

```text
Browser → local Node.js token broker → Direct Line /tokens/generate
```

The Direct Line secret stays in `.env`. The browser receives only a short-lived token.

D2E uses a local delegated MSAL cache created by `npm run d2e:login`. The cache is stored under `.cache/` and is ignored by Git.

Never commit:

- `.env`;
- `.cache/`;
- Direct Line secrets or tokens;
- Entra access/refresh tokens;
- copied PAC `.mcs/` workspaces containing environment metadata.

## Prerequisites

- Node.js 20 or later;
- a published Copilot Studio agent;
- for Direct Line: a Direct Line secret or Copilot Studio token endpoint;
- for D2E:
  - Environment ID;
  - Agent schema name;
  - Tenant ID;
  - an Entra public client app with delegated `CopilotStudio.Copilots.Invoke` permission.

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Fill only the modes you want to test.

### Direct Line

```dotenv
DIRECTLINE_SECRET=your-local-secret
```

Or:

```dotenv
COPILOT_TOKEN_ENDPOINT=https://.../directline/token?api-version=2022-03-01-preview
```

### D2E delegated login

```dotenv
APP_CLIENT_ID=00000000-0000-0000-0000-000000000000
TENANT_ID=00000000-0000-0000-0000-000000000000
ENVIRONMENT_ID=00000000-0000-0000-0000-000000000000
AGENT_SCHEMA_NAME=your_agent_schema_name
```

Complete one device login:

```powershell
npm run d2e:login
```

Then start the toolkit:

```powershell
npm start
```

Open <http://localhost:3102>.

## Direct Line streaming protocol

The client forces WebSocket transport and sends a `startConversation` event:

```js
{
  type: 'event',
  name: 'startConversation',
  deliveryMode: 'stream',
  entities: [{
    type: 'ClientCapabilities',
    requiresBotState: true,
    supportsListening: true,
    supportsTts: true
  }]
}
```

Every outgoing user message also includes:

```js
{ deliveryMode: 'stream' }
```

Interim cumulative snapshots are normalized to the same activity ID (`id = streamId`) so Web Chat updates one bubble instead of rendering hundreds of partial bubbles.

If Direct Line returns only ordinary `typing` activities and one final `message`, the channel is connected but the service did not emit livestream metadata. There is currently no documented Maker UI for the observed `Channels_SupportForStreamingEnabled` capability flag; contact Microsoft support when client opt-in is correct but chunks remain zero.

## D2E streaming protocol

The Node.js backend uses the official SDK:

```js
client.startConversationStreaming(...)
client.sendActivityStreaming(activity)
```

Activities are proxied to the browser as Server-Sent Events. The UI renders informative steps separately and updates the answer using the stable `streamId`.

Some environments disable app-only D2E and return:

```text
App-only S2S access is not enabled for this environment.
```

This toolkit intentionally uses delegated user authentication for broad compatibility.

## Clone a Copilot Studio agent with PAC CLI

See [docs/pac-copilot-template-clone-agent.md](docs/pac-copilot-template-clone-agent.md).

The runbook covers:

- clone suitability checks;
- `pac copilot extract-template` and `pac copilot create`;
- schema/prefix rewrites;
- restoring instructions;
- component library handling;
- connection reference verification;
- unsupported knowledge-source limitations;
- sensitive `.mcs` cache cleanup.

The workflow was validated with PAC CLI 2.9.3. Revalidate behavior after upgrading PAC or moving across environments.

## Project structure

```text
.
├─ public/
│  ├─ index.html
│  ├─ streaming.css
│  └─ streaming.js
├─ scripts/
│  └─ d2e-login.js
├─ docs/
│  └─ pac-copilot-template-clone-agent.md
├─ .env.example
├─ server.js
└─ package.json
```

## Validation

```powershell
npm run check
```

## References

- [Copilot Studio custom application channel](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-connect-bot-to-custom-application)
- [Bot Framework Web Chat livestreaming](https://github.com/microsoft/BotFramework-WebChat/blob/main/docs/LIVESTREAMING.md)
- [Direct Line authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-direct-line-3-0-authentication)
- [Microsoft 365 Agents SDK](https://github.com/microsoft/Agents-for-js)
- [Power Platform CLI](https://learn.microsoft.com/en-us/power-platform/developer/cli/introduction)

## License

MIT
