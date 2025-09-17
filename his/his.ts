/**
 * 消息历史查询插件 - 查询指定用户或频道在群内的发言历史
 * 
 * @author TeleBox Team
 * @version 2.0.0
 */

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 工具函数
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 使用messages.search高效搜索指定用户的消息
 * 从dme.ts/da.ts移植的优化搜索函数
 */
async function searchUserMessagesOptimized(
  client: any,
  chatEntity: any,
  targetUserId: string | number,
  limit: number = 30
): Promise<Api.Message[]> {
  const userMessages: Api.Message[] = [];
  let offsetId = 0;

  console.log(`[HIS] 使用优化搜索模式，查询用户 ${targetUserId} 的消息`);

  try {
    while (userMessages.length < limit) {
      const batchSize = Math.min(100, limit - userMessages.length);
      
      // 使用messages.search直接搜索指定用户的消息
      const searchResult = await client.invoke(
        new Api.messages.Search({
          peer: chatEntity,
          q: "", // 空查询搜索所有消息
          fromId: await client.getInputEntity(targetUserId.toString()), // 关键：指定from_id
          filter: new Api.InputMessagesFilterEmpty(), // 不过滤消息类型
          minDate: 0,
          maxDate: 0,
          offsetId: offsetId,
          addOffset: 0,
          limit: batchSize,
          maxId: 0,
          minId: 0,
          hash: 0 as any
        })
      );

      // 正确处理搜索结果类型
      const resultMessages = (searchResult as any).messages;
      if (!resultMessages || resultMessages.length === 0) {
        console.log(`[HIS] 搜索完成，共找到 ${userMessages.length} 条用户消息`);
        break;
      }

      const messages = resultMessages.filter((m: any) => 
        (m.className === "Message" || m.className === "MessageService") && 
        m.senderId?.toString() === targetUserId.toString()
      );

      if (messages.length > 0) {
        userMessages.push(...messages);
        offsetId = messages[messages.length - 1].id;
        console.log(`[HIS] 批次搜索到 ${messages.length} 条消息，总计 ${userMessages.length} 条`);
      } else {
        break;
      }

      // 避免API限制
      await sleep(200);
      
      // 如果已达到目标数量，退出
      if (userMessages.length >= limit) {
        break;
      }
    }
  } catch (error: any) {
    console.error("[HIS] 优化搜索失败:", error);
    return [];
  }

  return userMessages.slice(0, limit);
}

// HTML转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文本定义（必需）
const help_text = `📜 <b>消息历史查询 - 高效版本</b>

<b>使用方法：</b>
• <code>${mainPrefix}his</code> - 回复消息时查询该用户历史
• <code>${mainPrefix}his &lt;目标&gt;</code> - 查询目标的消息历史
• <code>${mainPrefix}his &lt;目标&gt; &lt;数量&gt;</code> - 查询指定数量消息
• <code>${mainPrefix}his &lt;数量&gt;</code> - 回复消息时查询指定数量

<b>示例：</b>
• 回复消息后：<code>${mainPrefix}his</code>
• <code>${mainPrefix}his @username</code>
• <code>${mainPrefix}his 123456789 10</code>
• 回复消息后：<code>${mainPrefix}his 5</code>

<b>🚀 技术改进：</b>
• 基于Telegram MTProto API的messages.search方法
• 使用from_id参数直接定位用户消息
• 避免遍历，显著提升查询效率

<b>注意事项：</b>
• 仅限群组使用
• 默认查询30条消息
• 目标可以是用户名、用户ID或频道ID`;


// 媒体类型映射
const MEDIA_TYPES: Record<string, string> = {
  "AUDIO": "[音频]",
  "DOCUMENT": "[文档]",
  "PHOTO": "[图片]",
  "STICKER": "[贴纸]",
  "VIDEO": "[视频]",
  "ANIMATION": "[动画]",
  "VOICE": "[语音]",
  "VIDEO_NOTE": "[视频消息]",
  "CONTACT": "[联系人]",
  "LOCATION": "[位置]",
  "VENUE": "[地点]",
  "POLL": "[投票]",
  "WEB_PAGE": "[网页]",
  "DICE": "[骰子]",
  "GAME": "[游戏]"
};

class HisPlugin extends Plugin {
  // 必须在 description 中引用 help_text
  description: string = `消息历史查询插件\n\n${help_text}`;
  
  constructor() {
    super();
  }

  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    his: async (msg: Api.Message, trigger?: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 简单参数解析
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身

      try {
        const DEFAULT_COUNT = 30;
        
        // 处理帮助命令
        if (args[0] === "help" || args[0] === "h") {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        // 无参数时的处理
        if (args.length === 0) {
          // 如果是回复消息，则查询被回复者
          if (msg.isReply) {
            const reply = await msg.getReplyMessage();
            if (reply && reply.senderId) {
              const target = reply.senderId.toString();
              await this.queryHistory(msg, target, DEFAULT_COUNT, client);
              return;
            }
          }
          
          // 否则显示错误提示
          await msg.edit({
            text: `❌ <b>参数不足</b>\n\n💡 使用 <code>${mainPrefix}his help</code> 查看帮助`,
            parseMode: "html"
          });
          return;
        }

        // 一个参数的情况
        if (args.length === 1) {
          const arg = args[0];
          const num = parseInt(arg);
          
          // 如果是数字且在回复消息的情况下，作为数量参数
          if (!isNaN(num) && num > 0 && msg.isReply) {
            const reply = await msg.getReplyMessage();
            if (reply && reply.senderId) {
              const target = reply.senderId.toString();
              const count = Math.min(num, 100); // 最大限制100条
              await this.queryHistory(msg, target, count, client);
              return;
            }
          }
          
          // 否则作为目标参数
          const target = this.parseEntity(arg);
          await this.queryHistory(msg, target, DEFAULT_COUNT, client);
          return;
        }

        // 两个参数的情况：目标 + 数量
        if (args.length === 2) {
          const target = this.parseEntity(args[0]);
          const num = parseInt(args[1]);
          
          if (isNaN(num) || num <= 0) {
            await msg.edit({
              text: "❌ 无效的数量参数",
              parseMode: "html"
            });
            return;
          }
          
          const count = Math.min(num, 100); // 最大限制100条
          await this.queryHistory(msg, target, count, client);
          return;
        }

        // 参数过多
        await msg.edit({
          text: `❌ <b>参数过多</b>\n\n💡 使用 <code>${mainPrefix}his help</code> 查看帮助`,
          parseMode: "html"
        });
        return;

      } catch (error: any) {
        console.error("[his] 插件执行失败:", error);
        
        // 处理特定错误类型
        if (error.message?.includes("FLOOD_WAIT")) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
          await msg.edit({
            text: `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`,
            parseMode: "html"
          });
          return;
        }
        
        if (error.message?.includes("MESSAGE_TOO_LONG")) {
          await msg.edit({
            text: "❌ <b>消息过长</b>\n\n请减少查询数量",
            parseMode: "html"
          });
          return;
        }
        
        // 通用错误处理
        await msg.edit({
          text: `❌ <b>操作失败:</b> ${htmlEscape(error.message || "未知错误")}`,
          parseMode: "html"
        });
      }
    }
  };


  // 查询历史消息
  private async queryHistory(msg: Api.Message, targetEntity: any, num: number, client: any): Promise<void> {
    const chatId = msg.peerId;

    // 显示处理中消息
    await msg.edit({ text: "🔍 正在查询消息历史...", parseMode: "html" });

    // 格式化目标实体显示
    let targetDisplay = "";
    try {
      const entity = await client.getEntity(targetEntity);
      if (entity) {
        const parts: string[] = [];
        if (entity.title) parts.push(entity.title);
        if (entity.firstName) parts.push(entity.firstName);
        if (entity.lastName) parts.push(entity.lastName);
        if (entity.username) parts.push(`@${entity.username}`);
        targetDisplay = parts.join(" ") || targetEntity.toString();
      } else {
        targetDisplay = targetEntity.toString();
      }
    } catch (error) {
      targetDisplay = targetEntity.toString();
    }

    // 获取聊天链接基础URL
    let baseLinkUrl = "";
    try {
      const chat = await client.getEntity(chatId);
      if (chat.username) {
        baseLinkUrl = `https://t.me/${chat.username}/`;
      } else if (chat.megagroup) {
        const chatIdStr = String(chatId).replace("-100", "");
        baseLinkUrl = `https://t.me/c/${chatIdStr}/`;
      }
    } catch (error) {
      console.error("[HIS] Could not get chat entity for linking:", error);
    }

    let count = 0;
    const messages: string[] = [];

    try {
      // 使用优化搜索获取消息
      const chatEntity = await client.getEntity(chatId);
      const foundMessages = await searchUserMessagesOptimized(client, chatEntity, targetEntity, num);

      if (foundMessages.length === 0) {
        await msg.edit({
          text: `❌ 未找到 <b>${htmlEscape(targetDisplay)}</b> 的消息记录`,
          parseMode: "html"
        });
        return;
      }

      // 处理找到的消息
      for (const message of foundMessages) {
        count++;
        let messageText = message.text || "";

        // 处理媒体消息
        if (message.media) {
          messageText = await this.processMediaMessage(message, messageText);
        }

        // 处理服务消息 (类型检查)
        if ((message as any).className === "MessageService") {
          const action = message.action;
          if (action.className === "MessageActionPinMessage") {
            const pinnedMessage = (action as any).message;
            messageText = "[置顶消息] " + pinnedMessage;
          } else if (action.className === "MessageActionChatEditTitle") {
            const newTitle = (action as any).title;
            messageText = "[修改群名] " + newTitle;
          } else {
            const serviceText = action.className.replace("MessageAction", "");
            messageText = "[服务消息] " + serviceText;
          }
        }

        if (!messageText) {
          messageText = "[Unsupported Message]";
        }

        // 格式化消息显示
        const messageTextDisplay = messageText.length > 50 
          ? `${messageText.substring(0, 50)}...`
          : messageText;

        // 添加链接（如果可用）
        if (baseLinkUrl) {
          const messageLink = `${baseLinkUrl}${message.id}`;
          messages.push(`${count}. <a href="${messageLink}">${htmlEscape(messageTextDisplay)}</a>`);
        } else {
          messages.push(`${count}. ${htmlEscape(messageTextDisplay)}`);
        }
      }

      if (messages.length === 0) {
        await msg.edit({
          text: `❌ 未找到 <b>${htmlEscape(targetDisplay)}</b> 的消息记录`,
          parseMode: "html"
        });
        return;
      }

      // 构建结果消息
      const header = `📜 <b>消息历史查询</b>\n\n` +
                    `👤 <b>目标:</b> ${htmlEscape(targetDisplay)}\n` +
                    `💬 <b>消息数:</b> ${messages.length}\n` +
                    `━━━━━━━━━━━━━━━━\n\n`;
      
      const results = header + messages.join("\n");

      // 分片发送长消息
      const MAX_LENGTH = 3500;
      if (results.length > MAX_LENGTH) {
        const chunks: string[] = [];
        let currentChunk = header;
        
        for (const message of messages) {
          if ((currentChunk + "\n" + message).length > MAX_LENGTH) {
            chunks.push(currentChunk);
            currentChunk = message;
          } else {
            currentChunk += (currentChunk ? "\n" : "") + message;
          }
        }
        if (currentChunk) {
          chunks.push(currentChunk);
        }

        // 发送第一片
        await msg.edit({
          text: chunks[0],
          parseMode: "html",
          linkPreview: false
        });

        // 发送后续片段
        for (let i = 1; i < chunks.length; i++) {
          await client.sendMessage(msg.peerId, {
            message: chunks[i],
            parseMode: "html",
            linkPreview: false
          });
        }
      } else {
        await msg.edit({
          text: results,
          parseMode: "html",
          linkPreview: false
        });
      }

      console.log(`[HIS] 查询完成 - 群组: ${chatId}, 目标: ${targetEntity.toString()}, 消息数: ${count}`);

    } catch (error: any) {
      console.error("[HIS_ERROR]:", error);
      await msg.edit({
        text: `❌ 查询失败: ${htmlEscape(error.message || "未知错误")}`,
        parseMode: "html"
      });
    }
  }

  // 处理媒体消息
  private async processMediaMessage(message: any, mediaCaption: string): Promise<string> {
    // 简化版本：总是显示媒体类型
    const showMediaType = true;
    if (!showMediaType) return mediaCaption;
    
    const media = message.media;
    
    if (media.className === "MessageMediaPhoto") {
      return MEDIA_TYPES.PHOTO + " " + mediaCaption;
    } else if (media.className === "MessageMediaDocument") {
      const doc = media.document;
      const attributes = doc.attributes || [];
      
      const isVideo = attributes.some((attr: any) => attr.className === "DocumentAttributeVideo");
      const isVoice = attributes.some((attr: any) => attr.className === "DocumentAttributeAudio" && attr.voice);
      const isAudio = attributes.some((attr: any) => attr.className === "DocumentAttributeAudio");
      const isSticker = attributes.some((attr: any) => attr.className === "DocumentAttributeSticker");
      const isAnimation = attributes.some((attr: any) => attr.className === "DocumentAttributeAnimated");

      if (isSticker) return MEDIA_TYPES.STICKER + " " + mediaCaption;
      if (isAnimation) return MEDIA_TYPES.ANIMATION + " " + mediaCaption;
      if (isVideo) return MEDIA_TYPES.VIDEO + " " + mediaCaption;
      if (isVoice) return MEDIA_TYPES.VOICE + " " + mediaCaption;
      if (isAudio) return MEDIA_TYPES.AUDIO + " " + mediaCaption;
      return MEDIA_TYPES.DOCUMENT + " " + mediaCaption;
    } else if (media.className === "MessageMediaContact") {
      return MEDIA_TYPES.CONTACT + " " + mediaCaption;
    } else if (media.className === "MessageMediaGeo" || media.className === "MessageMediaVenue") {
      return MEDIA_TYPES.LOCATION + " " + mediaCaption;
    } else if (media.className === "MessageMediaPoll") {
      return MEDIA_TYPES.POLL + " " + mediaCaption;
    } else if (media.className === "MessageMediaWebPage") {
      return MEDIA_TYPES.WEB_PAGE + " " + mediaCaption;
    } else if (media.className === "MessageMediaDice") {
      return MEDIA_TYPES.DICE + " " + mediaCaption;
    } else if (media.className === "MessageMediaGame") {
      return MEDIA_TYPES.GAME + " " + mediaCaption;
    }

    return mediaCaption;
  }
  
  // 解析实体参数
  private parseEntity(argStr: string): string | number {
    // 尝试解析为数字ID
    const num = parseInt(argStr);
    if (!isNaN(num)) {
      return num;
    }
    // 否则作为用户名返回
    return argStr;
  }
}

export default new HisPlugin();
