# 使用 PAC CLI 模板克隆 Copilot Studio Agent

> 适用场景：在**同一个 Dataverse 环境**中，把现有 Copilot Studio Agent 创建为一个新的 Agent（新 `schemaName`、新 Bot ID），同时复用已有 Cloud Flow、Dataverse Action 与 Connection Reference。  
> 实测基线：Windows + Power Platform CLI 2.9.3。其他版本、跨环境或不同连接策略必须重新验证。

## 结论

`pac copilot clone` 只下载并绑定原 Agent，不能创建新 Agent；含 Actions、Workflows 或 Connection References 的工作区可能无法使用 `pac copilot pack`。已验证的同环境克隆路径是：

```text
pac copilot extract-template → 检查模板 → pac copilot create
```

平台为新 Agent 分配新 Bot ID。模板保留的 Flow ID 和 Connection Reference 会尝试解析到同环境中的既有组件，但创建后仍必须检查连接绑定与权限。

## 命令关系

| 目标 | 命令 |
|---|---|
| 查看环境中的 Agent | `pac copilot list --environment <env>` |
| 从源 Agent 抽取模板 | `pac copilot extract-template` |
| 用模板创建新 Agent | `pac copilot create` |
| 发布 Agent | `pac copilot publish` |
| 查看部署状态 | `pac copilot status` |

## 为什么不用 clone / pack

| 方式 | 实际效果 | 是否适合创建独立 Agent |
|---|---|---|
| `pac copilot clone` | 下载本地工作区，Sync 元数据仍指向原 Agent；`push` 更新原 Agent | 否 |
| `pac copilot pack` | 将工作区打成 Solution ZIP；PAC 2.9.3 对含 Actions/Workflows/Connection References 的工作区可能拒绝打包 | 通常不适合本场景 |
| `extract-template` + `create` | 平台 API 创建新 Agent，使用新 `schemaName` 与新 Bot ID | 是 |

## 前置条件

1. 安装 Power Platform CLI：

   ```powershell
   pac help
   ```

   PAC 2.9.3 中 `pac --version` 可能同时打印版本与解析错误，优先使用 `pac help` 或 `pac`。

2. 准备目标环境 Auth Profile：

   ```powershell
   pac auth who
   pac auth list
   pac auth create --environment "<env-url>"
   ```

3. 环境内准备一个 **Unmanaged Solution**。`pac copilot create --solution` 使用 Solution **唯一名**，不是显示名。
4. 新 Agent 的 `schemaName` 前缀应与 Solution Publisher Prefix 一致。
5. 执行账户需要创建 Agent、读取依赖和按需发布的权限。

## 1. 确认源 Agent

```powershell
pac copilot list --environment "<env-url>"
```

记录源 Agent 的 Copilot ID。PAC 2.9.3 中不带 `--environment` 可能只输出登录信息，因此始终显式指定环境。

## 2. 抽取模板（只读）

```powershell
pac copilot extract-template `
  --environment "<env-url>" `
  --bot "<source-copilot-id>" `
  --templateFileName ".\agent.yaml" `
  --templateName "<template-name>" `
  --templateVersion "1.0.0" `
  --overwrite
```

PAC 2.9.3 的帮助可能把 `--templateName` 与 `--templateVersion` 标为可选，但实测省略版本会报参数错误，因此建议始终显式提供。

检查模板：

```powershell
Get-Content ".\agent.yaml" -TotalCount 40
Select-String -Path ".\agent.yaml" -Pattern "flowId|connection|instructions|GptComponent"
```

### 关键限制：模板不包含 Instructions

PAC 2.9.3 的 `extract-template` 实测不会导出 Agent 的 GPT Instructions / System Prompt。模板通常包含 Topics、Actions 及 Flow/Connection Reference 引用，但没有 `GptComponentMetadata.instructions`。

源 Instructions 可从 `pac copilot clone` 生成的 `agent.mcs.yml` 中读取。创建新 Agent 后必须补回，详见“补回 Instructions”。

## 3. 准备 Unmanaged Solution

查看现有 Solution：

```powershell
pac solution list --environment "<env-url>"
```

如需新建：

```powershell
pac solution init `
  --publisher-name <PublisherName> `
  --publisher-prefix <prefix> `
  --outputDirectory .\newsol

pac solution pack `
  --zipfile .\newsol.zip `
  --folder .\newsol\src `
  --packagetype Unmanaged

pac solution import `
  --environment "<env-url>" `
  --path .\newsol.zip `
  --publish-changes
```

注意：

- `solution init` 只创建本地项目；必须 Pack + Import 才会在环境中创建 Solution。
- `import --publish-changes` 可能触发耗时较长的发布过程。
- `schemaName` 必须使用目标 Solution Publisher Prefix，例如 `usc_userselfserviceclone`。

## 4. 创建新 Agent

```powershell
pac copilot create `
  --environment "<env-url>" `
  --displayName "<new-agent-display-name>" `
  --schemaName "<prefix>_<new-unique-name>" `
  --solution "<solution-unique-name>" `
  --templateFileName ".\agent.yaml"
```

规则：

- `schemaName` 必须在环境内唯一。
- `displayName` 不要求唯一，不能用来判断是否新建。
- 新 Bot ID 由平台生成，无需手工提供 GUID。
- 同环境中的 Flow/Connection Reference 引用会尝试解析到既有组件，但必须在创建后复核。

如终端表格输出缺失，可重定向后查看：

```powershell
pac copilot list --environment "<env-url>" *> copilot-list.txt
Get-Content .\copilot-list.txt
```

## 5. 验证新 Agent

```powershell
pac copilot list --environment "<env-url>" *> copilot-list.txt
Get-Content .\copilot-list.txt
```

确认：

1. 新旧 Agent 使用不同 Copilot ID，并同时存在。
2. 新 Agent 的 Topics 与 Actions 符合模板预期。
3. Action 指向既有 Flow，Flow ID 没有意外改变。
4. Connection Reference 已绑定有效连接；如未绑定，在 Maker 门户选择已有连接。
5. 源 Agent 未被覆盖。
6. 新 Agent 的 Instructions 已补回。

### 发布状态

PAC 2.9.3 同环境实测中，`create` 后 Agent 可能已显示 `Published / Provisioned`，但这不是跨版本保证。应先检查状态，仅在需要时执行：

```powershell
pac copilot publish `
  --environment "<env-url>" `
  --bot "<new-copilot-id>"

pac copilot status `
  --environment "<env-url>" `
  --bot-id "<new-copilot-id>"
```

注意参数差异：`publish` 使用 `--bot`，`status` 使用 `--bot-id`。

## 6. 补回 Instructions（必做）

### 方式 A：Copilot Studio UI

1. 打开源 Agent，复制 Instructions 全文。
2. 打开新 Agent，粘贴 Instructions。
3. 保存，并按实际状态判断是否需要发布。

### 方式 B：CLI 工作区

```powershell
pac copilot clone `
  --environment "<env-url>" `
  --bot "<new-copilot-id>" `
  --display-name "<clone-folder>" `
  --output-dir .\clone-new
```

把源 Agent `agent.mcs.yml` 中 `GptComponentMetadata.instructions` 的 YAML 块复制到新 Agent 工作区对应位置。保持缩进，只替换 Instructions 文本，不修改新 Agent 自己的 Component Name、Schema Name 或其他身份元数据。

然后回写：

```powershell
pac copilot push --project-dir .\clone-new\<clone-folder>
```

Push 后重新打开 Agent，确认 Instructions 非空，并按需保存/发布和复测。

## 7. 验收清单

| 检查项 | 预期结果 |
|---|---|
| 新旧 Agent 并存 | 不同 Copilot ID |
| Schema Name | 新 Agent 使用唯一值，Publisher Prefix 正确 |
| Topics / Actions | 与源模板一致 |
| Instructions | 已手工补回并确认非空 |
| Flow 复用 | Action 指向同一个既有 Flow |
| Connection Reference | 已绑定环境中的有效连接 |
| 发布状态 | 已实际检查，而不是假设 `create` 一定发布 |
| 源 Agent | Bot ID 与内容未被覆盖 |
| 最小黑盒 | 新 Agent 真实调用依赖并返回预期结果 |

## 8. 常见问题

### `--solution` 不存在

使用 Solution 唯一名，并通过以下命令确认：

```powershell
pac solution list --environment "<env-url>"
```

### Action / Flow 不能运行

检查：

- Flow 是否已开启。
- Connection Reference 是否绑定有效连接。
- 执行账户对 Flow、Dataverse 与 Connector 是否有权限。
- 新 Agent 的身份和 Authentication 配置是否满足依赖要求。

### Schema Name 冲突

`pac copilot create` 依据 `schemaName` 识别组件，不依据 `displayName`：

- 新 `schemaName`：创建独立 Agent。
- 已存在的 `schemaName`：可能报重复错误，或产生覆盖/更新风险。

创建前检查：

```powershell
pac copilot list --environment "<env-url>" *> copilot-list.txt
Select-String -Path .\copilot-list.txt -Pattern "<agent-name-or-schema-name>"
```

### Connection Reference 没有自动绑定

同环境通常可以解析引用，但 Connection 与 Connection Reference 不完全等同。若未绑定，应在 Copilot Studio 或 Solution 中选择已有连接，保存后重新验证；不要把“引用存在”当作“身份连接可用”的证据。

## 9. 最短路径

```powershell
# 1. 抽模板
pac copilot extract-template --environment "<env-url>" --bot "<source-copilot-id>" --templateFileName ".\agent.yaml" --templateName "<template-name>" --templateVersion "1.0.0" --overwrite

# 2. 使用唯一 schemaName 创建新 Agent
pac copilot create --environment "<env-url>" --displayName "<new-name>" --schemaName "<prefix>_<new-name>" --solution "<solution-unique-name>" --templateFileName ".\agent.yaml"

# 3. 补回 Instructions，复核 Flow/Connection Reference，并执行最小黑盒验证
```

## 官方参考

- [Microsoft Power Platform CLI copilot command group](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/copilot)
- [Microsoft Power Platform CLI solution command group](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/solution)
