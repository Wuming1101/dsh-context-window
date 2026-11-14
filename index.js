/**
 * dsh-memory-context-window
 *
 * 记忆优先预设（preset-memory）的上下文窗口插件。
 *
 * 做一件很窄的事：每轮结束时，把「更早的轮次」从模型可见的 session surface 上
 * 替换掉，只保留最近 retainTurns 轮原文。替换用的是 session 原生的
 * `surfaceOp: { op: 'replace' }`——它只 shadow 模型可见视图：
 *   - 会话事件日志（原文）不动，可审计、可回溯；
 *   - 客户端聊天记录按 append-origin 渲染，用户看到的对话不变；
 *   - 模型这一轮只看得到最近 retainTurns 轮 + system prompt 里的记忆注入。
 *
 * 为什么不改请求：agent-loop 在 buildRequest 里对请求对象和每条消息做了
 * Object.freeze / deepFreeze，llm/stream 钩子里改不动（2026-11-12 已验）。
 *
 * 【2026-11-13 修复】V4 会话格式要求 developer/message 必须落在打开的 step 内
 * （带合法 turn/step 坐标）。原来在 agent/turn-stopping 里 append：此时引擎已写
 * step/end（finally 先落盘再派发事件），append 出去的折叠消息要么缺 turn/step
 * 被编码器拒绝（`developer/message turn must be a non-negative safe integer`，
 * 整批写盘失败、持久化队列堵死），要么补了坐标却写在 step/end 之后，重启后
 * 读校验炸（`developer/message does not match an open turn and step`，会话文件
 * 整体拒载）。两个都是它。
 *
 * 修复：turn-stopping 时只算好折叠范围存起来（只读，不写盘），等下一轮
 * step/start 落盘后（session/event 同步触发）再 append——此时 step 开着，
 * 用 step/start 事件里的 turn/step 坐标，位置与坐标都合法。空转轮（inbox
 * 转发的 turn，没有 step）不会清掉已算好的范围；surface 在 turn/end 与下一
 * 个 step/start 之间不会变化，范围始终有效。
 *
 * 配置（预设条目里可覆盖）：
 *   enabled      默认 true
 *   retainTurns  默认 1，保留最近几轮原文
 *   placeholder  替换后模型看到的占位说明
 */

import { randomUUID } from 'node:crypto'

const DEFAULT_PLACEHOLDER =
  '更早的对话已不在本轮上下文中——这是本预设的常态，不是故障。' +
  '需要旧信息时，先用 companion_memory_search 检索记忆；记忆里没有再问，不要假装记得原文。'

const SYSTEM_PROMPT_SOURCE = { kind: 'system-prompt' }

export function apply(ctx, config = {}) {
  if (config.enabled === false) return () => {}

  const retainTurns = Number.isFinite(config.retainTurns) ? Math.max(1, config.retainTurns) : 1
  const placeholder = typeof config.placeholder === 'string' && config.placeholder
    ? config.placeholder
    : DEFAULT_PLACEHOLDER

  const on = (event, handler) => {
    if (typeof ctx?.on !== 'function') return () => {}
    try {
      const dispose = ctx.on(event, handler)
      return typeof dispose === 'function' ? dispose : () => {}
    } catch {
      return () => {}
    }
  }

  const warn = (message) => {
    try {
      ctx?.logger?.warn?.(`[memory-context-window] ${message}`)
    } catch {
      /* ignore */
    }
  }

  // 只读：算好待折叠的范围。返回 null 表示这轮没有可折叠的东西。
  const computeTrim = (agent) => {
    const session = agent?.session
    if (!session?.surface || typeof session.append !== 'function') return null

    const nodes = [...session.surface.nodes]
    if (nodes.length === 0) return null

    // 只读日志尾部找 turn 边界（turn/start 是 log-only 事件，不在 surface 上）
    const events = session.snapshotEvents()
    if (!Array.isArray(events) || events.length === 0) return null

    const starts = []
    for (let i = events.length - 1; i >= 0 && starts.length <= retainTurns; i--) {
      if (events[i]?.type === 'turn/start') starts.push(events[i].seq)
      if (starts.length > retainTurns) break
    }
    // 轮次还不够 retainTurns 轮：没有可替换的东西
    if (starts.length <= retainTurns) return null
    const keepFrom = starts[retainTurns - 1]

    // node 0 若是 system prompt，受 surface 规则保护，从 node 1 开始
    const head = events[nodes[0]]?.type === 'system/message' ? 1 : 0
    const targets = nodes.slice(head).filter((seq) => seq < keepFrom)
    if (targets.length === 0) return null

    const first = targets[0]
    const last = targets[targets.length - 1]
    const startIdx = nodes.indexOf(first)
    const endIdx = nodes.indexOf(last)
    if (startIdx < 0 || endIdx < 0) return null
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    // 只替换连续区间；中间有别的节点就保守跳过
    if (shadowed.length !== targets.length) return null

    return { session, first, last, shadowed }
  }

  // 待执行的折叠计划。turn-stopping 时算好，下一轮 step/start 后执行。
  let pendingTrim = null

  const disposeTurnStopping = on('agent/turn-stopping', (payload) => {
    try {
      const plan = computeTrim(payload?.agent)
      if (plan) pendingTrim = plan
    } catch (error) {
      warn(`裁剪范围计算失败：${error?.message ?? error}`)
    }
  })

  const disposeSessionEvent = on('session/event', (session, event) => {
    try {
      if (!pendingTrim || session !== pendingTrim.session) return
      if (event?.type !== 'step/start') return
      const turn = event?.data?.turn
      const step = event?.data?.step
      if (!Number.isFinite(turn) || !Number.isFinite(step)) return
      // session/event 在 append 的 commit 内同步触发，此刻重入 append 会被
      // 拒绝（session append cannot reenter）；挪到微任务，等本次 commit 结束。
      // 微任务会在 step() 的第一个 await（prepareRequest）处排空，仍早于
      // buildRequest——本轮模型请求就已经看不到旧轮次。
      const plan = pendingTrim
      queueMicrotask(() => {
        if (!plan) return
        try {
          session.append(
            'developer/message',
            {
              turn,
              step,
              message: {
                id: randomUUID(),
                role: 'developer',
                source: SYSTEM_PROMPT_SOURCE,
                content: [{ type: 'text', text: placeholder }],
              },
            },
            {
              surfaceOp: { op: 'replace', startSeq: plan.first, endSeq: plan.last },
              sourceEventSeqs: plan.shadowed,
            },
          )
          if (pendingTrim === plan) pendingTrim = null
        } catch (error) {
          warn(`裁剪执行失败：${error?.message ?? error}`)
        }
      })
    } catch (error) {
      warn(`裁剪调度失败：${error?.message ?? error}`)
    }
  })

  return () => {
    try {
      disposeTurnStopping()
    } catch {
      /* ignore */
    }
    try {
      disposeSessionEvent()
    } catch {
      /* ignore */
    }
  }
}

export const name = 'dsh-memory-context-window'
export default { name, apply }
