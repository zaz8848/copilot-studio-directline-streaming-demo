# Copilot Studio Direct Line Streaming Demo

一个**纯前端、单文件**的 Copilot Studio Direct Line WebSocket 真流式验证工具。

它不是把最终消息切片播放的“打字机动画”，而是请求 Copilot Studio 服务端实际下发 livestreaming activities：

```text
informative typing → streaming typing #1..N → final message
```

页面同时提供 Activity Inspector，可直接判断服务端是否真正下发了：

- `streamType`
- `streamId`
- `streamSequence`
- `entities[type="streaminfo"]` 或 `channelData`

## 两条真流式路径

Copilot Studio 目前有两种真流式接入方式：

| 路径 | 传输 | 认证 | 客户端 opt-in | 适合场景 |
|---|---|---|---|---|
| Direct-to-Engine SDK | SSE | Entra ID + `CopilotStudio.Copilots.Invoke` | 不需要 | 登录用户、完整 SDK 集成 |
| Direct Line | WebSocket | Direct Line token | 必须发送 `deliveryMode:"stream"` | 匿名 Agent、自定义 WebChat |

本仓库实现第二种：**Direct Line WebSocket + streaming opt-in**。

## 实现原理

### 1. 强制使用 WebSocket

```js
WebChat.createDirectLine({
  token,
  domain: 'https://directline.botframework.com/v3/directline',
  webSocket: true
});
```

Direct Line REST 会忽略 `typing` activities，不能用于 livestreaming。

### 2. 连接成功后声明流式能力

```js
directLine.postActivity({
  type: 'event',
  name: 'startConversation',
  deliveryMode: 'stream',
  channelId: 'webchat',
  entities: [{
    type: 'ClientCapabilities',
    requiresBotState: true,
    supportsListening: true,
    supportsTts: true
  }]
});
```

### 3. 每条用户消息请求流式返回

```js
connection.postActivity({
  ...activity,
  deliveryMode: 'stream'
});
```

### 4. 合并为一个增长气泡

服务端的每个增量片段可能有不同的 activity ID，但同一个回答共享 `streamId`。

Demo 将中间片段标准化为：

```js
{
  ...activity,
  type: 'message',
  id: streamId
}
```

WebChat 会按相同 ID 原位更新一个气泡，而不是创建几十个气泡。

## 快速开始

### 1. 获取 Direct Line Secret

在 Copilot Studio Agent 中进入：

```text
Settings → Safety & access → Web channel security → Secrets and tokens
```

复制 Secret 1 或 Secret 2。

### 2. 本地填写 Secret

打开 `index.html`，找到：

```js
const DIRECT_LINE_SECRET = 'PASTE_YOUR_DIRECT_LINE_SECRET_HERE';
```

只在本地替换占位符：

```js
const DIRECT_LINE_SECRET = 'your-local-test-secret';
```

> **不要提交真实 Secret。** 本仓库中的占位符必须保留。

### 3. 启动静态服务器

```powershell
npm install
npm start
```

打开：

```text
http://localhost:3102
```

也可以使用任意静态服务器托管 `index.html`。

### 4. 验证

1. 点击 **连接 Agent**。
2. 发送一个要求长回答的生成式问题。
3. 查看右侧 Activity Inspector。

真流式应看到：

```text
informative #1
streaming #1
streaming #2
streaming #3
...
final
```

并且 `chunks` 持续增长。

如果只看到多个普通 `typing` 和一个最终 `message`：

```text
typing
typing
typing
message
```

则通道已连接，但 Agent 服务端没有下发 livestreaming metadata。

## Agent 侧前置条件

除了客户端发送 `deliveryMode:"stream"`，Agent/环境还需要支持 Direct Line streaming。

当前实验环境中观察到的后端功能标志名称为：

```text
Channels_SupportForStreamingEnabled
```

目前没有发现 Microsoft Learn 中公开的 Maker UI 开关或公开 API。若客户端 opt-in 正确但持续收到 `0` 个 streaming chunks，需要通过 Power Platform / Copilot Studio 支持渠道确认该能力是否已为目标 Agent、环境和区域启用。

提交支持请求时建议提供：

- Environment ID
- Agent/Bot ID
- Schema name
- Direct Line WebSocket 已连接的证据
- `deliveryMode:"stream"` 和 `ClientCapabilities` 已发送的证据
- 原始 activity 中缺少 `streamType/streamId/streamSequence` 的日志

## 安全说明

此 Demo 为了方便本地验证，直接在浏览器中使用 Secret 换取短期 token。

这意味着：

- 仅适合本地测试；
- 不适合部署到公开网站；
- 不要提交填入真实 Secret 的版本；
- 不要在截图、日志或 Issue 中粘贴 Secret。

生产环境应使用 token broker：

```text
Browser → your backend → Direct Line /tokens/generate
```

后端从 Key Vault / Secret Store 读取 Secret，浏览器只接收短期 Direct Line token。

## 官方链接

- [Copilot Studio — Publish an agent to mobile or custom apps（官方 Direct Line 接入）](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-connect-bot-to-custom-application)
- [Copilot Studio — Publish an agent to a live or demo website](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-connect-bot-to-web-channels)
- [Bot Framework WebChat — Livestreaming](https://github.com/microsoft/BotFramework-WebChat/blob/main/docs/LIVESTREAMING.md)
- [Direct Line API 3.0 — Key concepts](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-direct-line-3-0-concepts)
- [Direct Line authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-direct-line-3-0-authentication)
- [Bot Framework WebChat](https://github.com/microsoft/BotFramework-WebChat)
- [Customize a Copilot Studio canvas](https://learn.microsoft.com/en-us/microsoft-copilot-studio/customize-default-canvas)
- [Copilot Studio support](https://learn.microsoft.com/en-us/microsoft-copilot-studio/fundamentals-support)
- [Power Platform support requests](https://admin.powerplatform.microsoft.com/support/requests)

## License

MIT
