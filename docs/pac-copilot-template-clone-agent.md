# 基于 `extract-template` + `create` 的 Copilot Studio Agent 带了那一个转向do面的那一个是我之前的，然后没有带的是你给我创建的，就是少东西了，你懂吗步骤（复用已有 flow / action / 连接）

> 适用场景：在**同一个 Dataverse 环境**里，把一个已存在的 Copilot Studio agent 克隆成**一个全新的 agent**（新 schema name、后台自动生成新 botid），并**复用**源 agent 引用的 cloud flow、Dataverse action 和连接（connection reference / connection），不重建这些依赖。
>
> 关键判断：`pac copilot clone` 只是把 agent 下载成本地工作区（sync 元数据仍绑定原 agent），并不能产生"新 agent"；而带 flow/action/connection reference 的 agent 又无法走 `pac copilot pack`。真正能用 pac 完成"克隆成新 agent 并复用依赖"的路径是：`pac copilot extract-template`（抽模板）→ `pac copilot create`（用模板建新 agent）。新 agent 的 GUID 由平台后台自动分配。

> ⚠️ **并非所有 Agent 都适用。** 2026-07-16 对 `Knowledge Agent` 的真实预检中，PAC 2.8.1 与 2.9.3 均在 `extract-template` 阶段报 `System.ArgumentException: Unknown knowledgeSources type`。该 Agent 包含 PAC 当前不能序列化的 Knowledge Source，因此无法进入 `create`。复杂 Agent 必须先以 `extract-template` 成功作为硬门槛，禁止在模板失败后继续创建不完整副本。

---

## 1. 命令关系速览(基于windows系统)

| 目标                 | 命令                                     |
| ------------------ | -------------------------------------- |
| 查看环境中的 agents      | `pac copilot list --environment <env>` |
| 从源 agent 抽取模板 yaml | `pac copilot extract-template`         |
| 用模板创建一个全新 agent    | `pac copilot create`                   |
| 发布新 agent          | `pac copilot publish`                  |
| 查看部署状态             | `pac copilot status`                   |

---

## 2. 为什么用 template 方案而不是 clone/pack

| 方式                            | 结果                                                   | 是否适合"克隆成新 agent"                                                       |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `pac copilot clone`           | 下载成本地文件工作区，sync 元数据指向**原 agent**；`push` 只更新原 agent   | ❌ 不产生新 agent                                                           |
| `pac copilot pack`            | 把工作区打成 solution zip                                  | ❌ 实测（pac 2.9.3）拒绝含 `actions/` `workflows/` `connectionreferences` 的工作区 |
| `extract-template` + `create` | 通过平台 API 新建 agent，新 schemaName + 后台自动生成 botid，内容来自模板 | ✅ 推荐                                                                   |

- 因为在**同环境**创建，模板里对 flow（`flowId`）、connection reference 的引用会原样解析到已存在的组件 → **flow / action 逻辑 / 连接全部复用，零重建**。
- 新 agent 的 botid 由平台自动生成，无需手工 mint GUID。

---

## 3. 前置条件

1. 本机已安装 Power Platform CLI。查看版本：

   ```powershell
   pac help
   ```

   > 注意（pac 2.9.3）：`pac --version` 不是合法命令，会打印版本号但同时报解析错误。用 `pac help` 或直接 `pac`。当前实操是根据2.9.3版本，不同版本是实际操作效果需进一步验证。

2. 已有指向目标环境的 auth profile：

   ```powershell
   pac auth who
   pac auth list
   ```

   如无，先创建：

   ```powershell
   pac auth create --environment "<env-url>"
   ```

3. 环境里已存在一个 **unmanaged solution**，用来承载新 agent（`pac copilot create` 的 `--solution` 需要它的唯一名）。新 agent 的 `--schemaName` 前缀最好与该 solution 的发布者前缀一致。

4. 你有在该环境创建 / 发布 agent 的权限。

---

## 4. 确认源 agent

```powershell
pac copilot list --environment "<env-url>"
```

在输出中记下要克隆的源 agent 的 **Copilot ID**。

> 注意（pac 2.9.3）：`pac copilot list` **不带 `--environment`** 时可能只输出 "Connected as ..." 而不列出任何 agent。始终显式传 `--environment "<env-url>"`。`Is Managed = False` 的是你自己的自定义 agent。

---

## 5. 从源 agent 抽取模板（只读，不改环境）

```powershell
pac copilot extract-template `
  --environment "<env-url>" `
  --bot "<source-copilot-id>" `
  --templateFileName ".\<agent>.yaml" `
  --templateName "<template-name>" `
  --templateVersion "1.0.0" `
  --overwrite
```

> 实测（pac 2.9.3）：`--templateName` 和 `--templateVersion` 虽然帮助里标为可选，但**不传会报错** `Argument --templateVersion is invalid. Expected type 1.0.0 and got:`。请**始终显式传入**这两个参数（版本形如 `1.0.0`）。`--overwrite` 允许重复写入同名 yaml。

完成后检查生成的 yaml：

```powershell
Get-Content ".\<agent>.yaml" -TotalCount 40
```

模板会包含源 agent 的 topics、actions 及对 flow / connection reference 的引用（例如 `kind: InvokeFlowTaskAction` 搭配硬引用的 `flowId`）。此步骤不会修改环境。

> ⚠️ 已确认缺陷（pac 2.9.3）：**`extract-template` 不导出 agent 的 Instructions（GPT 生成式指令 / system prompt）**。模板 yaml 里**没有** `GptComponentMetadata`、也没有任何 `instructions` 字段，只有 topics（`DialogComponent`）和 actions（`TaskDialog`）。因此后面 `create` 出的克隆 agent **Instructions 会是空的**，必须按第 8.1 节手动补回。
>
> 验证方法：`Select-String -Path .\<agent>.yaml -Pattern "instructions|GptComponent"` —— 无匹配即证实模板不含 instructions。而源 agent 的 instructions 实际存在于 `pac copilot clone` 产出的 `agent.mcs.yml` 的 `GptComponentMetadata.instructions` 里。

---

## 6. 准备承载新 agent 的 solution

`pac copilot create` 需要 `--solution <solution-unique-name>`，且必须是环境里**已存在的 unmanaged solution**。

先看现有 solution：

```powershell
pac solution list --environment "<env-url>"
```

若没有合适的，用 pac 三步新建一个（实测可行）：

```powershell
# a. 本地初始化 solution 项目（指定发布者名与前缀）
pac solution init --publisher-name <PublisherName> --publisher-prefix <prefix> --outputDirectory .\newsol

# b. 把项目 src 打包成 unmanaged zip
pac solution pack --zipfile .\newsol.zip --folder .\newsol\src --packagetype Unmanaged

# c. 导入环境（会创建 solution + publisher）
pac solution import --environment "<env-url>" --path .\newsol.zip --publish-changes
```

> 实测要点：
>
> - `pac solution init` 只在**本地**建项目，不会直接在环境里建 solution；必须再 `pack` + `import`。
> - `import --publish-changes` 会触发全量发布，在组件多的环境里**耗时较长**，导入命令会占住当前终端直到完成，请耐心等待。
> - 新 agent 的 `--schemaName` 前缀必须与该 solution 的**发布者前缀一致**（例如上面用 `usc`，则 schemaName 用 `usc_...`）。

也可以直接在 Power Apps / Copilot Studio maker 门户新建一个 unmanaged solution，效果相同。

---

## 7. 用模板创建一个全新 agent

要点：

* `--schemaName` 必须是环境内**唯一**、且与 solution 发布者前缀匹配（例如 `usc_userselfserviceclone`），不要与源 agent 相同，详情见10.3。
* `--displayName` 只是显示名，可自由取。
* 新 agent 的 **botid 由平台后台自动生成**，无需手工指定。
* flow（`flowId`）与 connection reference 的引用随模板带入 → 新 agent 复用它们。

```powershell
pac copilot create `
  --environment "<env-url>" `
  --displayName "<new-agent-display-name>" `
  --schemaName "<prefix>_<newuniquename>" `
  --solution "<solution-unique-name>" `
  --templateFileName ".\<agent>.yaml"
```



实测成功输出示例（pac 2.9.3）：

```text
Loaded 15 components for copilot 'User Self Service Clone' with id dec9f245-99d3-4289-9909-c63c4e6a7fc0. ...
Copilot created successfully: https://web.powerva.microsoft.com/environments/.../bots/dec9f245-...
```

输出里的 `id` 就是新 agent 的 botid（后面验证会用到）。

> 实测小技巧：pac 命令的表格输出在某些终端里可能只显示 “Connected as ...” 而丢表格。把输出重定向到文件再读可靠：`... *> out.txt; Get-Content out.txt`。

---

## 8. 验证新 agent

1. 确认新 agent 已创建、且与源 agent 并存：

   ```powershell
   pac copilot list --environment "<env-url>" *> copilot_list.txt; Get-Content copilot_list.txt
   ```

   应能看到新的 display name / 新的 Copilot ID，与源 agent（原 botid）并存，源 agent 未被覆盖。

2. 在 Copilot Studio 打开新 agent，检查：

   - topics、actions 是否与源一致。
   - action 指向的 flow 是否解析到已有 flow（复用成功）。
   - connection reference 是否已连接到环境已有连接；若提示未绑定，手动选择连接。

> 实测：`pac copilot create` 后，新 agent 在 `pac copilot list` 里的状态已是 **Published / Provisioned**，通常**无需再跑 `pac copilot publish`**。如确实需要手动发布，才用：
>
> ```powershell
> pac copilot publish --environment "<env-url>" --bot "<new-copilot-id>"
> pac copilot status  --environment "<env-url>" --bot-id "<new-copilot-id>"
> ```
>
> 参数差异：`publish` 用 `--bot`，`status` 用 `--bot-id`。

### 8.1 补回 agent Instructions（必做）

由于 `extract-template` 不导出 Instructions（见第 5 节缺陷说明），`create` 出的新 agent Instructions 为空，需手动补回。源 agent 的 Instructions 原文在 `pac copilot clone` 产出的 `agent.mcs.yml` 的 `GptComponentMetadata.instructions` 字段。

**方式 A：Copilot Studio UI（最简单）**

- 打开源 agent，复制其 Instructions 全文。
- 打开新克隆 agent，粘贴到 Instructions，保存并发布。

**方式 B：纯 CLI（clone 新 agent → 改 `agent.mcs.yml` → push）**

```powershell
# 1. 把新 agent clone 成工作区
pac copilot clone --environment "<env-url>" --bot "<new-copilot-id>" --display-name "<clone-folder>" --output-dir .\clone-new

# 2. 把源 agent 的 instructions 填进新工作区的 agent.mcs.yml
#    源 instructions 在 .\source-clone\<源agent>\agent.mcs.yml 的 GptComponentMetadata.instructions
#    编辑 .\clone-new\<clone-folder>\agent.mcs.yml，把同名 instructions 段替换为源内容

# 3. 回写到新 agent
pac copilot push --project-dir .\clone-new\<clone-folder>
```

> 提示：`agent.mcs.yml` 的 `instructions:` 是 YAML 块标量（`|+`），替换时保持缩进一致，只改 instructions 文本、不要动 `componentName` / `schemaName` 等新 agent 自己的元数据。

---

## 9. 验证清单

| 检查项              | 目标结果                                                               |
| ---------------- | ------------------------------------------------------------------ |
| 新旧 agent 并存      | `pac copilot list` 里能看到两个不同 Copilot ID                             |
| 新 agent 内容       | topics / actions 与源一致                                              |
| Instructions 已补回 | ⚠️ extract-template 不带 Instructions，需按 8.1 手动补回并确认非空               |
| flow 复用          | 新 agent 的 action 指向同一个已有 flow（flowId 未变）                           |
| 连接复用             | connection reference 绑定到已有连接，无需新建                                  |
| 创建即已发布           | create 后 `pac copilot list` 状态为 Published/Provisioned，无需额外 publish |
| 源 agent 未受影响     | 源 agent 仍为原 botid、内容未被覆盖                                           |

---

## 10. 常见问题

### 10.1 create 报 `--solution` 不存在

`--solution` 必须是环境里已存在 solution 的**唯一名**（不是显示名）。先用 `pac solution list` 确认，或在门户建一个 unmanaged solution。

### 10.2 新 agent 打开后 action / flow 不能运行

- 确认 flow 在环境里是开启（turned on）状态。
- 确认 connection reference 已绑定到有效连接。
- 确认调用账户对该 flow / Dataverse / connector 有权限。

### 10.3 是否新建由 `--schemaName` 决定（不是 displayName）

`pac copilot create` 认的是 `--schemaName`（唯一名），**不是** `--displayName`（显示名）：

- **新的 schemaName** → 新建一个全新 agent（botid 后台自动生成），哪怕 displayName 与已有 agent 完全相同也照样新建（displayName 不要求唯一）。
- **相同的 schemaName** → 不会得到干净的新副本，而是**撞车**：可能报重复错误，或匹配到既有 agent 而覆盖/更新它。

> ⚠️ 提醒：批量克隆或多次 create 时，**每次必须换一个不同的 `--schemaName`**，否则第二次会撞上第一次那个。想覆盖既有 agent 才刻意沿用相同 schemaName。

**create 前先检查目标环境是否已存在同名（同 schemaName）agent：**

```powershell
# 列出当前所有 agent（含 schema name / Copilot ID），重定向到文件再筛
pac copilot list --environment "<env-url>" *> copilot_list.txt

# 按显示名或 schemaName 关键字检查是否已存在
Select-String -Path copilot_list.txt -Pattern "<agent-name-or-schemaname>"
```

- 若已存在且**不想覆盖** → 换一个新的 `--schemaName` 再 create。
- 若确实要覆盖那一个 → 沿用相同 schemaName（并确认你接受覆盖）。

> 注：`pac copilot list` 默认列出 Copilot ID / display name；schemaName（唯一名）可在 Copilot Studio 的 Bot Details 或 solution explorer 文件名中查看，命名冲突以 schemaName 为准。

### 10.4 connection reference 未自动绑定

同环境下通常自动解析；若未绑定，在 Copilot Studio 的新 agent 里手动为对应 action 选择连接后保存并重新发布。

### 10.5 `extract-template` 报 `Unknown knowledgeSources type`

这表示源 Agent 包含当前 PAC CLI 不支持序列化的 Knowledge Source 类型。已验证 PAC 2.8.1 与 2.9.3 都可能发生此错误，升级到 2.9.3 不一定解决。

处理原则：

1. **立即停止 `create`**；没有完整模板就不能声称完成克隆。
2. 不要用 `clone → push` 替代，因为 Clone Workspace 仍绑定源 Agent，Push 可能更新源 Agent。
3. `pac copilot pack` 也不是通用回退；包含 `connectionreferences.mcs.yml`、`actions/`、`knowledge/`、`settings/`、`workflows/` 的复杂工作区会被 PAC 2.9.3 判定为不支持。
4. 不要修改源 Agent 来临时移除 Knowledge Source，除非另有明确变更授权和回滚方案。
5. 改用 Microsoft 后续支持的 CLI 版本、官方 UI 复制能力或经过验证的 Solution ALM 路线；在此之前将该 Agent 标记为“PAC 模板克隆不可用”。

安全提醒：`pac copilot clone` 生成的隐藏 `.mcs/` 缓存可能包含环境级元数据、Connection 信息或 Environment Variable Value。实验目录必须加入 `.gitignore`，验证后删除，禁止提交到仓库。

---

## 11. 最短路径总结

```powershell
# 0.（若无现成 solution）新建一个 unmanaged solution
pac solution init --publisher-name <PublisherName> --publisher-prefix <prefix> --outputDirectory .\newsol
pac solution pack --zipfile .\newsol.zip --folder .\newsol\src --packagetype Unmanaged
pac solution import --environment "<env-url>" --path .\newsol.zip --publish-changes

# 1. 抽模板
pac copilot extract-template --environment "<env-url>" --bot "<source-copilot-id>" --templateFileName ".\agent.yaml" --templateName "<template-name>" --templateVersion "1.0.0" --overwrite

# 2. 用模板建新 agent（新 schemaName，后台自动生成 botid）
pac copilot create --environment "<env-url>" --displayName "<new-name>" --schemaName "<prefix>_<newname>" --solution "<solution-unique-name>" --templateFileName ".\agent.yaml"
```

> create 后新 agent 即为 Published/Provisioned，**无需额外 `pac copilot publish`**。

---

## 12. 官方参考

- [Microsoft Power Platform CLI copilot command group](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/copilot)
- [Microsoft Power Platform CLI solution command group](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/solution)
