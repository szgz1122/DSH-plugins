/**
 * dsh-deepseek-share
 *
 * 在 DSH 输入框「+」的指令面板里注册一条命令：
 *   /deepseek-share <DeepSeek 网页版分享链接>
 *
 * 命令会读取分享页的公开接口，把对话整理成 Markdown，然后通过
 * agent.steer() 作为一条普通用户消息交给当前会话的模型阅读。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildAgentPrompt, fetchShare, formatShareTranscript, parseShareId } from './format.js'

export const name = 'deepseek-share'
export const inject = ['commands']

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'deepseek-share',
        description: '读取 DeepSeek 网页版分享链接中的对话（/deepseek-share <链接>）',
        input: { hint: '<DeepSeek 分享链接>' },
        handler: async ({ agent, rawInput }) => {
          let shareId
          try {
            shareId = parseShareId(rawInput)
          } catch (error) {
            return { kind: 'error', text: String(error?.message || error) }
          }

          let payload
          try {
            payload = await fetchShare(shareId)
          } catch (error) {
            return { kind: 'error', text: `读取分享对话失败：${String(error?.message || error)}` }
          }

          let transcript
          try {
            transcript = formatShareTranscript(payload, shareId)
          } catch (error) {
            return { kind: 'error', text: `整理分享对话失败：${String(error?.message || error)}` }
          }

          if (!agent || typeof agent.steer !== 'function') {
            return { kind: 'error', text: '当前会话没有可用的 Agent，无法把分享内容交给模型' }
          }

          const message = createUserMessage({
            content: [{ type: 'text', text: buildAgentPrompt(transcript) }],
            source: { kind: 'dsh-deepseek-share', shareId, url: `https://chat.deepseek.com/share/${shareId}` },
          })
          await agent.steer(message)

          return {
            kind: 'success',
            text: `已读取「${transcript.title}」，共 ${transcript.messageCount} 条消息（用户 ${transcript.userCount} 条、回答 ${transcript.assistantCount} 条），已交给模型阅读。`,
          }
        },
      }),
    'deepseek-share: /deepseek-share command'
  )
}
