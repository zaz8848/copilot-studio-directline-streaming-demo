/* global WebChat */
'use strict'

const el = id => document.getElementById(id)
const connectionState = el('connectionState')
const connectionLabel = el('connectionLabel')
const connectionHint = el('connectionHint')
const conversationId = el('conversationId')
const emptyState = el('emptyState')
const activityLog = el('activityLog')
const thinking = el('thinking')
const thinkingSteps = el('thinkingSteps')
const connectionSource = el('connectionSource')
const browserConfig = el('browserConfig')
const connectionStringInput = el('connectionString')
const connectionModeBadge = el('connectionModeBadge')
const securityMode = el('securityMode')
const newConversationButton = el('newConversationButton')
const transportMode = el('transportMode')
const directLineConfig = el('directLineConfig')
const d2eConfig = el('d2eConfig')
const transportLabel = el('transportLabel')
const streamingProtocol = el('streamingProtocol')
const directLineFlow = el('directLineFlow')
const directLineRequirement = el('directLineRequirement')
const metrics = {
    streams: el('streamMetric'),
    chunks: el('chunkMetric'),
    final: el('finalMetric'),
    latency: el('latencyMetric'),
}
const diagnosis = el('diagnosis')
const storageKey = 'directLineStreaming.connection'
const directLineBase = 'https://directline.botframework.com/v3/directline'

let connection
let currentUserId
let subscriptions = []
let autoScrollObserver
let startedAt
let firstChunkAt
let promptSent = false
let chunkCount = 0
let finalCount = 0
let plainBotMessages = 0
const streamIds = new Set()
const informativeSteps = []

function createUserId() {
    return `dl_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`
}

function restoreConnectionSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')
        connectionSource.value = saved.source === 'browser' ? 'browser' : 'server'
        connectionStringInput.value = saved.connectionString || ''
    } catch {
        connectionSource.value = 'server'
    }
    refreshConnectionSettings()
}

function refreshConnectionSettings() {
    const d2e = transportMode.value === 'd2e'
    directLineConfig.hidden = d2e
    d2eConfig.hidden = !d2e
    directLineFlow.hidden = d2e
    directLineRequirement.hidden = d2e
    transportLabel.textContent = d2e ? 'Direct-to-Engine SSE' : 'Direct Line WebSocket'
    streamingProtocol.textContent = d2e ? 'sendActivityStreaming()' : 'deliveryMode: stream'
    if (d2e) {
        connectionModeBadge.textContent = 'D2E · DELEGATED'
        securityMode.textContent = 'Entra 委托缓存'
        connectionHint.textContent = 'Node.js 服务端调用 D2E SDK，浏览器接收 SSE。'
        connectionHint.className = 'hint'
        return
    }
    const browserManaged = connectionSource.value === 'browser'
    browserConfig.hidden = !browserManaged
    connectionModeBadge.textContent = browserManaged ? 'BROWSER LOCAL' : 'SERVER RELAY'
    securityMode.textContent = browserManaged ? '本地 Connection' : '短期 Token'
    if (browserManaged) {
        connectionHint.textContent = connectionStringInput.value
            ? '已加载浏览器本地 Connection String。'
            : '请输入 Connection String 并保存。'
    } else {
        connectionHint.textContent = 'Secret 仅保留在服务端。'
    }
    connectionHint.className = 'hint'
}

function persistConnectionSettings() {
    localStorage.setItem(storageKey, JSON.stringify({
        source: connectionSource.value,
        connectionString: connectionStringInput.value.trim(),
    }))
}

async function acquireBrowserToken(value) {
    if (!value) throw new Error('请先填写 Connection String')

    if (/^https?:\/\//i.test(value)) {
        const response = await fetch(value)
        if (!response.ok) throw new Error(`Token Endpoint 返回 HTTP ${response.status}`)
        const data = await response.json()
        if (!data.token) throw new Error('Token Endpoint 没有返回 token')
        return {
            ...data,
            userId: createUserId(),
            source: 'browser-token-endpoint',
            domain: directLineBase,
        }
    }

    if (value.split('.').length === 3) {
        return { token: value, userId: createUserId(), source: 'browser-token', domain: directLineBase }
    }

    const response = await fetch(`${directLineBase}/tokens/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: { id: createUserId(), name: 'Local streaming test user' } }),
    })
    if (!response.ok) throw new Error(`Direct Line Secret 换 Token 失败：HTTP ${response.status}`)
    const data = await response.json()
    if (!data.token) throw new Error('Direct Line 没有返回 token')
    return {
        ...data,
        userId: data.user?.id || createUserId(),
        source: 'browser-direct-line-secret',
        domain: directLineBase,
    }
}

async function acquireConnection() {
    if (connectionSource.value === 'browser') {
        return acquireBrowserToken(connectionStringInput.value.trim())
    }
    const response = await fetch('/api/directline/token', { method: 'POST' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `Token request failed: HTTP ${response.status}`)
    return data
}

function setConnection(state, label, hint, hintType = '') {
    connectionState.dataset.state = state
    connectionLabel.textContent = label
    if (hint !== undefined) connectionHint.textContent = hint
    connectionHint.className = `hint ${hintType}`
}

function resetInspector() {
    startedAt = performance.now()
    firstChunkAt = undefined
    promptSent = false
    chunkCount = 0
    finalCount = 0
    plainBotMessages = 0
    streamIds.clear()
    informativeSteps.length = 0
    activityLog.innerHTML = ''
    thinkingSteps.innerHTML = ''
    thinking.hidden = true
    metrics.streams.textContent = '0'
    metrics.chunks.textContent = '0'
    metrics.final.textContent = '0'
    metrics.latency.textContent = '—'
    diagnosis.dataset.state = 'idle'
    diagnosis.innerHTML = '<span class="diagnosis-icon">·</span><div><strong>等待测试</strong><p>发送消息后判断是否为服务端真流式。</p></div>'
}

function beginPromptTest() {
    startedAt = performance.now()
    firstChunkAt = undefined
    promptSent = true
    chunkCount = 0
    finalCount = 0
    plainBotMessages = 0
    streamIds.clear()
    informativeSteps.length = 0
    thinkingSteps.innerHTML = ''
    thinking.hidden = true
    activityLog.innerHTML = ''
    metrics.streams.textContent = '0'
    metrics.chunks.textContent = '0'
    metrics.final.textContent = '0'
    metrics.latency.textContent = '—'
    diagnosis.dataset.state = 'idle'
    diagnosis.innerHTML = '<span class="diagnosis-icon">·</span><div><strong>等待 Agent 回答</strong><p>正在监听 streaminfo 元数据。</p></div>'
}

function getStreamInfo(activity) {
    const raw = activity.channelData?.streamType
        ? activity.channelData
        : (activity.entities || []).find(item => item?.type === 'streaminfo' && item.streamType)
    if (!raw) return null

    const { streamType, streamId, streamSequence } = raw
    const validSequence = Number.isInteger(streamSequence) && streamSequence >= 1
    const valid = (
        ((streamType === 'streaming' || streamType === 'informative') && activity.type === 'typing' && validSequence)
        || (streamType === 'final' && (activity.type === 'message' || activity.type === 'typing') && Boolean(streamId))
    )
    return { streamType, streamId, streamSequence, valid }
}

function updateDiagnosis() {
    if (chunkCount > 0) {
        diagnosis.dataset.state = 'ok'
        diagnosis.innerHTML = '<span class="diagnosis-icon">✓</span><div><strong>服务端真流式已确认</strong><p>收到带 streaminfo 的原生片段，不是前端打字机动画。</p></div>'
    } else if (plainBotMessages > 0 || finalCount > 0) {
        diagnosis.dataset.state = 'warn'
        diagnosis.innerHTML = '<span class="diagnosis-icon">!</span><div><strong>当前仅收到最终消息</strong><p>检查 Agent 的 Channels_SupportForStreamingEnabled 是否开启。</p></div>'
    }
}

function renderThinkingStep(text) {
    if (!text || informativeSteps.includes(text)) return
    informativeSteps.push(text)
    const item = document.createElement('li')
    item.textContent = text
    thinkingSteps.append(item)
    thinking.hidden = false
}

function hideThinking() {
    thinking.hidden = true
}

function logActivity(activity) {
    const info = getStreamInfo(activity)
    const isUserActivity = activity.from?.role === 'user' || activity.from?.id === currentUserId
    const isBotMessage = activity.type === 'message' && !isUserActivity
    const isBotTyping = activity.type === 'typing' && !isUserActivity
    if (!info && !isBotMessage && !isBotTyping) return

    let kind = info?.streamType || activity.type
    if (info && !info.valid) kind = 'malformed'

    if (promptSent && info?.valid) {
        if (info.streamType === 'streaming' || info.streamType === 'informative') {
            chunkCount += 1
            if (!firstChunkAt) {
                firstChunkAt = performance.now()
                metrics.latency.textContent = `${Math.round(firstChunkAt - startedAt)}ms`
            }
        }
        if (info.streamType === 'final') finalCount += 1
        if (info.streamId) streamIds.add(info.streamId)
    } else if (promptSent && isBotMessage) {
        plainBotMessages += 1
        finalCount += 1
    }

    metrics.streams.textContent = String(streamIds.size)
    metrics.chunks.textContent = String(chunkCount)
    metrics.final.textContent = String(finalCount)
    updateDiagnosis()

    const item = document.createElement('li')
    item.className = `activity ${kind}`
    const text = (activity.text || '').replace(/\s+/g, ' ').slice(0, 180)
    item.innerHTML = `
        <div class="activity-top">
            <span class="activity-type">${kind}</span>
            <span class="activity-seq">${info?.streamSequence ? `#${info.streamSequence}` : activity.type}</span>
        </div>
        ${text ? '<p class="activity-text"></p>' : ''}
    `
    if (text) item.querySelector('.activity-text').textContent = text
    activityLog.prepend(item)

    while (activityLog.children.length > 80) activityLog.lastElementChild.remove()
}

// Adapted from jzh24516/copilot-streaming-chat-playground.
// It subscribes to Direct Line once, groups cumulative chunks by streamId into
// one growing Web Chat bubble, and drops the untagged duplicate final message.
function wrapWithDirectLineStreaming(rawConnection) {
    const observers = new Set()
    const completed = new Map()
    let upstreamSubscription

    const broadcast = activity => {
        for (const observer of observers) observer.next?.(activity)
    }

    const handle = activity => {
        const info = getStreamInfo(activity)

        if (info?.valid && info.streamType === 'informative') {
            renderThinkingStep(activity.text)
            return
        }
        if (info?.valid && info.streamType === 'streaming') {
            hideThinking()
            const id = info.streamId || activity.id
            const text = activity.text || ''
            completed.set(id, text)
            broadcast({
                ...activity,
                type: 'message',
                id,
                text,
                from: { ...(activity.from || {}), role: 'bot' },
            })
            return
        }
        if (info?.valid && info.streamType === 'final') {
            hideThinking()
            const id = info.streamId || activity.id
            const text = activity.text || completed.get(id) || ''
            completed.set(id, text)
            broadcast({ ...activity, type: 'message', id, text, from: { ...(activity.from || {}), role: 'bot' } })
            return
        }

        const isUserActivity = activity.from?.role === 'user' || activity.from?.id === currentUserId
        const isBotMessage = activity.type === 'message' && !isUserActivity
        if (isBotMessage && !info && activity.text) {
            for (const finalText of completed.values()) {
                if (finalText === activity.text) return
            }
        }
        broadcast(activity)
    }

    const activity$ = {
        subscribe(observerOrNext, error, complete) {
            const observer = typeof observerOrNext === 'function'
                ? { next: observerOrNext, error, complete }
                : observerOrNext || {}
            observers.add(observer)
            if (observers.size === 1) {
                upstreamSubscription = rawConnection.activity$.subscribe({
                    next: activity => {
                        conversationId.textContent = `conversation · ${rawConnection.conversationId || 'pending'} `
                        logActivity(activity)
                        try { handle(activity) } catch (error) { console.warn(error); broadcast(activity) }
                    },
                    error: reason => observers.forEach(target => target.error?.(reason)),
                    complete: () => observers.forEach(target => target.complete?.()),
                })
            }
            return {
                unsubscribe() {
                    observers.delete(observer)
                    if (!observers.size && upstreamSubscription) {
                        upstreamSubscription.unsubscribe()
                        upstreamSubscription = undefined
                    }
                },
            }
        },
    }

    const wrapped = Object.create(rawConnection)
    wrapped.activity$ = activity$
    wrapped.postActivity = activity => {
        if (activity?.type === 'message') beginPromptTest()
        return rawConnection.postActivity(
            activity?.type === 'message' ? { ...activity, deliveryMode: 'stream' } : activity,
        )
    }
    return wrapped
}

function attachAutoScroll() {
    autoScrollObserver?.disconnect()
    const host = el('webchat')
    const findScrollable = () => host.querySelector('.webchat__basic-transcript__scrollable')
        || host.querySelector('[class*="transcript"][class*="scrollable"]')
    autoScrollObserver = new MutationObserver(() => {
        const node = findScrollable()
        if (!node) return
        const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 100
        if (nearBottom) node.scrollTop = node.scrollHeight
    })
    autoScrollObserver.observe(host, { childList: true, subtree: true, characterData: true })
}

async function disconnect() {
    subscriptions.forEach(subscription => {
        try { subscription.unsubscribe() } catch { /* no-op */ }
    })
    subscriptions = []
    autoScrollObserver?.disconnect()
    autoScrollObserver = undefined
    if (connection) {
        try { connection.end?.() } catch { /* no-op */ }
    }
    connection = undefined
    el('webchat').querySelector('.webchat-mount')?.remove()
    el('webchat').querySelector('.d2e-chat')?.remove()
}

async function connect() {
    newConversationButton.disabled = true
    await disconnect()
    resetInspector()
    if (transportMode.value === 'd2e') return connectD2E()
    const browserManaged = connectionSource.value === 'browser'
    setConnection(
        'connecting',
        '正在获取 Token',
        browserManaged ? '正在使用浏览器本地 Connection String…' : '正在通过服务端安全中继连接 Direct Line…',
    )
    emptyState.hidden = false

    try {
        const data = await acquireConnection()
        currentUserId = data.userId

        const rawConnection = WebChat.createDirectLine({
            token: data.token,
            domain: data.domain,
            webSocket: true,
        })
        connection = wrapWithDirectLineStreaming(rawConnection)

        let optInSent = false
        subscriptions.push(connection.connectionStatus$.subscribe(status => {
            if (status === 1) setConnection('connecting', '正在建立 WebSocket')
            if (status === 2) {
                setConnection('online', 'Direct Line 已连接', 'WebSocket 已就绪，Streaming opt-in 已发送。', 'ok')
                newConversationButton.disabled = false
                conversationId.textContent = `conversation · ${rawConnection.conversationId || data.conversationId || 'pending'} `
                if (!optInSent) {
                    optInSent = true
                    connection.postActivity({
                        type: 'event',
                        name: 'startConversation',
                        deliveryMode: 'stream',
                        channelId: 'webchat',
                        from: { id: data.userId, role: 'user' },
                        locale: 'zh-CN',
                        channelData: { postBack: true },
                        value: { __version__: '2' },
                        entities: [{
                            type: 'ClientCapabilities',
                            requiresBotState: true,
                            supportsListening: true,
                            supportsTts: true,
                        }],
                    }).subscribe({
                        error: error => setConnection('error', '流式请求失败', error.message, 'error'),
                    })
                }
            }
            if (status === 4) {
                setConnection('error', '连接失败', 'Direct Line 拒绝连接，请检查 Secret 或 Channel。', 'error')
                newConversationButton.disabled = false
            }
            if (status === 5) {
                setConnection('error', '连接已结束', '请点击重新连接。', 'error')
                newConversationButton.disabled = false
            }
        }))

        emptyState.hidden = true
        const mount = document.createElement('div')
        mount.className = 'webchat-mount'
        el('webchat').append(mount)

        WebChat.renderWebChat({
            directLine: connection,
            userID: data.userId,
            locale: 'zh-CN',
            styleOptions: {
                accent: '#155eef',
                backgroundColor: '#fbfcfe',
                botAvatarInitials: 'AI',
                userAvatarInitials: '我',
                bubbleBackground: '#ffffff',
                bubbleBorderColor: '#e4e7ec',
                bubbleBorderRadius: 14,
                bubbleFromUserBackground: '#155eef',
                bubbleFromUserTextColor: '#ffffff',
                bubbleFromUserBorderRadius: 14,
                rootHeight: '100%',
                sendBoxBackground: '#ffffff',
                sendBoxBorderTop: 'solid 1px #e4e7ec',
                sendBoxTextWrap: true,
                sendTypingIndicator: true,
                disableFileUpload: true,
            },
        }, mount)
        attachAutoScroll()
    } catch (error) {
        console.error(error)
        setConnection('error', '启动失败', error.message, 'error')
        emptyState.hidden = false
        emptyState.querySelector('h3').textContent = '无法建立 Direct Line 连接'
        emptyState.querySelector('p').textContent = error.message
        newConversationButton.disabled = false
    }
}

function appendD2EMessage(text, role, id) {
    let message = id ? document.querySelector(`[data-d2e-id="${CSS.escape(id)}"]`) : null
    if (!message) {
        message = document.createElement('article')
        message.className = `d2e-message ${role}`
        if (id) message.dataset.d2eId = id
        el('d2eTranscript').append(message)
    }
    message.textContent = text
    message.scrollIntoView({ block: 'end' })
}

async function sendD2E(text) {
    text = text.trim()
    if (!text) return
    appendD2EMessage(text, 'user')
    el('d2eInput').value = ''
    el('d2eSend').disabled = true
    beginPromptTest()
    try {
        const response = await fetch('/api/d2e/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        })
        if (!response.ok) throw new Error(`D2E 返回 HTTP ${response.status}`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const frames = buffer.split('\n\n')
            buffer = frames.pop() || ''
            for (const frame of frames) {
                const event = frame.match(/^event: (.+)$/m)?.[1] || 'message'
                const raw = frame.match(/^data: (.+)$/m)?.[1]
                if (!raw) continue
                const data = JSON.parse(raw)
                if (event === 'error') throw new Error(data.error)
                if (event === 'done') continue
                logActivity(data)
                const info = getStreamInfo(data)
                if (info?.streamType === 'informative') {
                    renderThinkingStep(data.text)
                    continue
                }
                if (info?.streamType === 'streaming') hideThinking()
                const id = info?.streamId || data.id || `d2e-${Date.now()}`
                if (data.text) appendD2EMessage(data.text, 'bot', id)
            }
        }
    } catch (error) {
        appendD2EMessage(`D2E 错误：${error.message}`, 'error')
        setConnection('error', 'D2E 请求失败', error.message, 'error')
    } finally {
        el('d2eSend').disabled = false
        el('d2eInput').focus()
    }
}

async function connectD2E() {
    setConnection('connecting', '正在创建 D2E 会话', '正在获取 App-only Token 并初始化 SDK…')
    emptyState.hidden = false
    try {
        const response = await fetch('/api/d2e/reset', {
            method: 'POST',
            signal: AbortSignal.timeout(35_000),
        })
        const result = await response.json()
        if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`)
        emptyState.hidden = true
        el('webchat').insertAdjacentHTML('beforeend', `
            <div class="d2e-chat">
                <div class="d2e-transcript" id="d2eTranscript"></div>
                <form class="d2e-composer" id="d2eForm">
                    <input id="d2eInput" autocomplete="off" placeholder="输入问题，观察原生流程输出…" />
                    <button id="d2eSend" type="submit">发送</button>
                </form>
            </div>`)
        el('d2eForm').addEventListener('submit', event => {
            event.preventDefault()
            sendD2E(el('d2eInput').value)
        })
        appendD2EMessage('D2E 会话已建立。发送一个较长问题，右侧会显示原生 informative / streaming / final。', 'system')
        conversationId.textContent = 'conversation · D2E delegated'
        setConnection('online', 'D2E 已连接', '原生 SDK Streaming 已就绪。', 'ok')
        newConversationButton.disabled = false
        el('d2eInput').focus()
    } catch (error) {
        setConnection('error', 'D2E 连接失败', error.message, 'error')
        emptyState.hidden = false
        emptyState.querySelector('h3').textContent = '无法建立 D2E 会话'
        emptyState.querySelector('p').textContent = error.message
        newConversationButton.disabled = false
    }
}

async function startNewConversation() {
    newConversationButton.disabled = true
    conversationId.textContent = 'conversation · 正在创建新会话'
    await connect()
}

async function testConnection() {
    const button = el('testButton')
    button.disabled = true
    connectionHint.textContent = '正在验证 Token、会话和 WebSocket streamUrl…'
    connectionHint.className = 'hint'
    try {
        let result
        if (transportMode.value === 'd2e') {
            const response = await fetch('/api/d2e/status')
            const status = await response.json()
            if (!status.configured) throw new Error('D2E S2S 配置不完整')
            connectionHint.textContent = `D2E 自检通过 · ${status.authentication} · ${status.transport}`
            connectionHint.className = 'hint ok'
            return
        } else if (connectionSource.value === 'browser') {
            const startedAt = performance.now()
            const data = await acquireConnection()
            const response = await fetch(`${data.domain}/conversations`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${data.token}` },
            })
            if (!response.ok) throw new Error(`创建 Direct Line 会话失败：HTTP ${response.status}`)
            const conversation = await response.json()
            result = {
                ok: true,
                webSocketStreamUrl: Boolean(conversation.streamUrl),
                elapsedMs: Math.round(performance.now() - startedAt),
            }
        } else {
            const response = await fetch('/api/test-connection')
            result = await response.json()
            if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`)
        }
        connectionHint.textContent = `自检通过 · Token ✓ · WebSocket ${result.webSocketStreamUrl ? '✓' : '✗'} · ${result.elapsedMs} ms`
        connectionHint.className = result.webSocketStreamUrl ? 'hint ok' : 'hint error'
    } catch (error) {
        connectionHint.textContent = `自检失败 · ${error.message} `
        connectionHint.className = 'hint error'
    } finally {
        button.disabled = false
    }
}

el('reconnectButton').addEventListener('click', connect)
newConversationButton.addEventListener('click', startNewConversation)
el('testButton').addEventListener('click', testConnection)
el('clearButton').addEventListener('click', () => { activityLog.innerHTML = '' })
connectionSource.addEventListener('change', () => {
    if (connectionSource.value === 'server') persistConnectionSettings()
    refreshConnectionSettings()
})
transportMode.addEventListener('change', () => {
    refreshConnectionSettings()
    connect()
})
el('saveConnectionButton').addEventListener('click', () => {
    const value = connectionStringInput.value.trim()
    if (!value) {
        connectionHint.textContent = 'Connection String 不能为空。'
        connectionHint.className = 'hint error'
        connectionStringInput.focus()
        return
    }
    persistConnectionSettings()
    connect()
})
el('clearConnectionButton').addEventListener('click', () => {
    connectionStringInput.value = ''
    localStorage.removeItem(storageKey)
    connectionSource.value = 'server'
    refreshConnectionSettings()
    connect()
})
el('revealButton').addEventListener('click', event => {
    const reveal = connectionStringInput.type === 'password'
    connectionStringInput.type = reveal ? 'text' : 'password'
    event.currentTarget.textContent = reveal ? '隐藏' : '显示'
    event.currentTarget.setAttribute('aria-label', reveal ? '隐藏 Connection String' : '显示 Connection String')
})

async function bootstrap() {
    restoreConnectionSettings()
    try {
        const response = await fetch('/api/config')
        const config = await response.json()
        if (!config.directLineConfigured && config.d2eConfigured) {
            transportMode.value = 'd2e'
            refreshConnectionSettings()
            return connect()
        }
        if (config.directLineConfigured) return connect()

        setConnection('error', '等待配置', '复制 .env.example 为 .env，然后配置 Direct Line 或 D2E。')
        emptyState.hidden = false
        emptyState.querySelector('h3').textContent = '尚未配置连接'
        emptyState.querySelector('p').textContent = '请按 README 配置 .env；也可以选择“浏览器本地配置”粘贴 Direct Line Token。'
        newConversationButton.disabled = true
    } catch (error) {
        setConnection('error', '无法读取配置', error.message, 'error')
    }
}

bootstrap()
