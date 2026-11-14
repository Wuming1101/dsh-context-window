# dsh-context-window ｜ 上下文窗口裁剪

每轮结束时把更早的轮次从「模型可见的会话 surface」上折叠掉，只保留最近 N 轮原文。原始事件日志一条不删，客户端看到的聊天记录也不变。

## 做什么

- 用会话原生的 `surfaceOp: { op: replace }` 只 shadow 模型可见视图
- 保留最近 `retainTurns` 轮原文，更早的轮次换成一段占位说明
- 折叠动作等到下一轮 `step/start` 落盘之后再写，保证 turn/step 坐标合法

## 不做什么

- 不删事件日志，不删数据库，客户端照旧显示完整聊天记录
- 不改 LLM 请求（agent-loop 会把请求对象深冻结，改了也不生效）

## 要求

| 项 | 要求 |
| --- | --- |
| DSH | 0.2.2-rc.1（需要 session surface 与 surfaceOp 能力） |
| Node | >= 22.12 |

## 安装

1. 在 profile 的 `package.json` 里加 `"dsh-context-window": "link:D:/plugins/dsh-context-window"`
2. 它是个纯插件，不挂 bundle patch：由预设或 profile 的 `cordis.patch.yml` 插入一行
3. 重启 DSH

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 开关 |
| `retainTurns` | `1` | 保留最近几轮原文 |
| `placeholder` | 内置一句中文说明 | 折叠后模型看到的那段话 |

## 什么时候值得用

长会话 + 记忆检索的组合：原文只留最近一轮，旧信息靠 `companion_memory_*` 捞。单轮任务或需要完整上下文的编码会话别开。

## 已知限制

- 依赖会话 surface 的折叠语义，换 DSH 大版本要先验一遍
- 折叠后模型看不到旧原文，占位说明要写清「先检索记忆再回答」


## 风险

- 模型看不到旧原文，长任务里可能答漏、答错；要完整上下文的活别开
- 折叠依赖会话 surface 的语义，DSH 升级后行为变了可能丢上下文
- `retainTurns` 调太小会更依赖记忆检索，检索不到就只能猜

---

作者：温凌微（Vera），网名暗海拾星。个人自用后整理开源，不是官方项目。
