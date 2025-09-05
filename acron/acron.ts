import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { getGlobalClient } from "@utils/globalClient";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const filePath = path.join(
  createDirectoryInAssets("acron"),
  "acron_config.json"
);
// DB schema and helpers
type AcronType = "del" | "del_re";

type AcronTaskBase = {
  id: string; // 自增主键（字符串格式）
  type: AcronType;
  cron: string;
  chat: string; // 用户输入的对话ID或@name
  chatId?: string; // 解析后的对话ID（字符串），使用时转 number
  createdAt: string; // 时间戳（字符串）
  lastRunAt?: string; // 时间戳（字符串）
  lastResult?: string; // 例如删除的数量
  lastError?: string;
  disabled?: boolean; // 是否被禁用
  remark?: string; // 备注
};

type DelTask = AcronTaskBase & {
  type: "del";
  msgId: string; // 存储为字符串
};

type DelReTask = AcronTaskBase & {
  type: "del_re";
  limit: string; // 最近消息条数（字符串）
  regex: string; // 正则表达式字符串，支持 /.../flags 或纯文本
};

type AcronTask = DelTask | DelReTask;

type AcronDB = {
  seq: string; // 自增计数器（字符串）
  tasks: AcronTask[];
};

async function getDB() {
  const db = await JSONFilePreset<AcronDB>(filePath, { seq: "0", tasks: [] });
  return db;
}

// 转换辅助：在使用时将字符串转 number，写入时存字符串
function toInt(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function toStrInt(value: any): string | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : undefined;
}

const CN_TIME_ZONE = "Asia/Shanghai";

function formatDate(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

async function formatEntity(target: any, throwErrorIfFailed?: boolean) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");
  let id: any;
  let entity: any;
  try {
    entity = target?.className
      ? target
      : ((await client?.getEntity(target)) as any);
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: any) {
    console.error(e);
    if (throwErrorIfFailed)
      throw new Error(
        `无法获取 ${target} 的 entity: ${e?.message || "未知错误"}`
      );
  }
  const displayParts: string[] = [];

  if (entity?.title) displayParts.push(entity.title);
  if (entity?.firstName) displayParts.push(entity.firstName);
  if (entity?.lastName) displayParts.push(entity.lastName);
  if (entity?.username) displayParts.push(`<code>@${entity.username}</code>`);

  if (id) {
    displayParts.push(
      entity instanceof Api.User
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`
    );
  } else if (!target?.className) {
    displayParts.push(`<code>${target}</code>`);
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}

function makeCronKey(id: string) {
  return `acron:${id}`;
}

function parseCronFromArgs(
  args: string[]
): { cron: string; rest: string[] } | null {
  // 固定为 6 段 (second minute hour dayOfMonth month dayOfWeek)
  const n = 6;
  if (args.length >= n) {
    const maybeCron = args.slice(0, n).join(" ");
    const validation = cron.validateCronExpression(maybeCron);
    if (validation.valid) {
      return { cron: maybeCron, rest: args.slice(n) };
    }
  }
  return null;
}

function buildCopyCommand(task: AcronTask): string {
  if (task.type === "del") {
    const remark = task.remark ? ` ${task.remark}` : "";
    return `${mainPrefix}acron del ${task.cron} ${task.chat} ${task.msgId}${remark}`;
  } else {
    // 尽量保留原始正则字符串
    const t = task as DelReTask;
    const remark = t.remark ? ` ${t.remark}` : "";
    return `${mainPrefix}acron del_re ${t.cron} ${t.chat} ${t.limit} ${t.regex}${remark}`;
  }
}

function tryParseRegex(input: string): RegExp {
  const trimmed = input.trim();
  if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
    const lastSlash = trimmed.lastIndexOf("/");
    const pattern = trimmed.slice(1, lastSlash);
    const flags = trimmed.slice(lastSlash + 1);
    return new RegExp(pattern, flags);
  }
  return new RegExp(trimmed);
}

async function scheduleTask(task: AcronTask) {
  const key = makeCronKey(task.id);
  if (task.disabled) return;
  if (cronManager.has(key)) return;

  cronManager.set(key, task.cron, async () => {
    const db = await getDB();
    const idx = db.data.tasks.findIndex((t) => t.id === task.id);
    const now = Date.now();
    try {
      const client = await getGlobalClient();
      const chatIdNum = toInt((task as any).chatId);
      const entityLike = (chatIdNum as any) ?? task.chat;

      if (task.type === "del") {
        const t = task as DelTask;
        const msgIdNum = toInt(t.msgId);
        if (msgIdNum !== undefined) {
          await client.deleteMessages(entityLike, [msgIdNum], { revoke: true });
        }
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已尝试删除消息 ${t.msgId}`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "del_re") {
        const t = task as DelReTask;
        const limitNum = toInt(t.limit) ?? 100;
        const messages = await client.getMessages(entityLike, {
          limit: limitNum,
        });
        const re = tryParseRegex(t.regex);
        const ids: number[] = [];
        for (const m of messages || []) {
          const mm = m as any;
          const text: string | undefined = mm.message ?? mm.text;
          if (typeof text === "string" && re.test(text)) {
            if (typeof mm.id === "number") ids.push(mm.id);
          }
        }
        if (ids.length > 0) {
          await client.deleteMessages(entityLike, ids, { revoke: true });
        }
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `匹配并删除 ${ids.length} 条`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      }
    } catch (e: any) {
      console.error(`[acron] 任务 ${task.id} 执行失败:`, e);
      if (idx >= 0) {
        db.data.tasks[idx].lastRunAt = String(now);
        db.data.tasks[idx].lastError = String(e?.message || e);
        await db.write();
      }
    }
  });
}

async function bootstrapTasks() {
  try {
    const db = await getDB();
    for (const t of db.data.tasks) {
      // 跳过无效表达式
      if (!cron.validateCronExpression(t.cron).valid) continue;
      if (t.disabled) continue;
      await scheduleTask(t);
    }
  } catch (e) {
    console.error("[acron] bootstrap 失败:", e);
  }
}

// 启动时注册历史任务（异步，不阻塞加载）
bootstrapTasks();

const help_text = `用法:
• <code>${mainPrefix}acron del 0 0 2 * * * 对话ID/@name 消息ID 备注</code> - 每天2点删除指定ID或@name的对话中的指定ID的消息
• <code>${mainPrefix}acron del_re 0 0 2 * * * 对话ID/@name 100 /^test/i 备注</code> - 每天2点删除指定ID或@name的对话中的最近的 100 条消息中 内容符合正则表达式的消息
• <code>${mainPrefix}acron list</code> - 列出当前会话中的所有定时任务
• <code>${mainPrefix}acron list all</code> - 列出所有的定时任务
• <code>${mainPrefix}acron list del</code> - 列出当前会话中的类型为 del 的定时任务
• <code>${mainPrefix}acron list all del</code> - 列出所有的类型为 del 的定时任务
• <code>${mainPrefix}acron rm 定时任务ID</code> - 删除指定的定时任务
• <code>${mainPrefix}acron disable 定时任务ID</code> - 禁用指定的定时任务
• <code>${mainPrefix}acron enable 定时任务ID</code> - 启用指定的定时任务
`;

class AcronPlugin extends Plugin {
  description: string = `定时发送/转发/复制/置顶/取消置顶/删除消息\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    acron: async (msg: Api.Message) => {
      const parts = msg.text?.trim()?.slice(1).split(/\s+/) || [];
      const [, ...args] = parts; // 跳过 "acron"
      const sub = (args[0] || "").toLowerCase();

      try {
        if (!sub) {
          await msg.edit({
            text: help_text,
            parseMode: "html",
          });
          return;
        }

        if (sub === "list") {
          const p1 = (args[1] || "").toLowerCase();
          const p2 = (args[2] || "").toLowerCase();

          const scopeAll = p1 === "all";
          const maybeType = (scopeAll ? p2 : p1) as AcronType | "";
          const typeFilter: AcronType | undefined =
            maybeType === "del" || maybeType === "del_re"
              ? maybeType
              : undefined;

          const typeLabel = (tp?: AcronType) =>
            tp === "del"
              ? "删除"
              : tp === "del_re"
              ? "正则删除"
              : String(tp || "");

          const db = await getDB();
          const chatId = Number(msg.chatId);
          const tasks = db.data.tasks
            .filter(
              (t) =>
                (scopeAll ? true : Number((t as any).chatId) === chatId) &&
                (!typeFilter || t.type === typeFilter)
            )
            // 先展示已启用的，再展示已禁用的
            .sort((a, b) => {
              const ad = a.disabled ? 1 : 0;
              const bd = b.disabled ? 1 : 0;
              return ad - bd;
            });

          if (tasks.length === 0) {
            const noneText = scopeAll
              ? typeFilter
                ? `暂无类型为 ${typeLabel(typeFilter)} 的定时任务`
                : "暂无定时任务"
              : typeFilter
              ? `当前会话暂无类型为 ${typeLabel(typeFilter)} 的定时任务`
              : "当前会话暂无定时任务";
            await msg.edit({ text: noneText });
            return;
          }

          const lines: string[] = [];
          const header = scopeAll
            ? typeFilter
              ? `📋 所有 ${typeLabel(typeFilter)} 定时任务:`
              : "📋 所有定时任务:"
            : typeFilter
            ? `📋 当前会话 ${typeLabel(typeFilter)} 定时任务:`
            : "📋 当前会话定时任务:";
          lines.push(header);
          lines.push("");

          // 分块显示：先启用，再禁用；如果对应块为空则不显示表头
          const enabledTasks = tasks.filter((t) => !t.disabled);
          const disabledTasks = tasks.filter((t) => t.disabled);

          if (enabledTasks.length > 0) {
            lines.push("🔛 已启用:");
            lines.push("");
            for (const t of enabledTasks) {
              const nextDt = cron.sendAt(t.cron);
              const entityInfo = await formatEntity(
                (t as any).chatId ?? t.chat
              );
              const title = `<code>${t.id}</code> • <code>${typeLabel(
                t.type
              )}</code>${t.remark ? ` • ${t.remark}` : ""}`;
              lines.push(title);
              lines.push(
                `对话: ${entityInfo?.display || `<code>${t.chat}</code>`}`
              );
              if (nextDt) {
                lines.push(`下次: ${formatDate(nextDt.toJSDate())}`);
              }
              if (t.lastRunAt) {
                lines.push(
                  `上次: ${formatDate(new Date(Number(t.lastRunAt)))}`
                );
              }
              if (t.lastResult) lines.push(`结果: ${t.lastResult}`);
              if (t.lastError) lines.push(`错误: ${t.lastError}`);
              lines.push(`复制: <code>${buildCopyCommand(t)}</code>`);
              lines.push("");
            }
          }

          if (disabledTasks.length > 0) {
            lines.push("⏹ 已禁用:");
            lines.push("");
            for (const t of disabledTasks) {
              const entityInfo = await formatEntity(
                (t as any).chatId ?? t.chat
              );
              const title = `<code>${t.id}</code> • <code>${typeLabel(
                t.type
              )}</code>${t.remark ? ` • ${t.remark}` : ""}`;
              lines.push(title);
              lines.push(
                `对话: ${entityInfo?.display || `<code>${t.chat}</code>`}`
              );
              // 禁用状态不显示下次执行
              if (t.lastRunAt) {
                lines.push(
                  `上次: ${formatDate(new Date(Number(t.lastRunAt)))}`
                );
              }
              if (t.lastResult) lines.push(`结果: ${t.lastResult}`);
              if (t.lastError) lines.push(`错误: ${t.lastError}`);
              lines.push(`复制: <code>${buildCopyCommand(t)}</code>`);
              lines.push("");
            }
          }

          // 分片发送，避免超长
          const full = lines.join("\n");
          const MAX = 3500; // 预留富文本开销
          const chunks: string[] = [];
          for (let i = 0; i < full.length; i += MAX) {
            chunks.push(full.slice(i, i + MAX));
          }
          if (chunks.length > 0) {
            await msg.edit({ text: chunks[0], parseMode: "html" });
            for (let i = 1; i < chunks.length; i++) {
              await msg.client?.sendMessage(msg.peerId, {
                message: chunks[i],
                parseMode: "html",
              });
            }
          }
          return;
        }

        if (sub === "rm") {
          const id = args[1];
          if (!id) {
            await msg.edit({
              text: "请提供定时任务ID: <code>${mainPrefix}acron rm ID</code>",
              parseMode: "html",
            });
            return;
          }
          const db = await getDB();
          const idx = db.data.tasks.findIndex((t) => t.id === id);
          if (idx < 0) {
            await msg.edit({
              text: `未找到任务: <code>${id}</code>`,
              parseMode: "html",
            });
            return;
          }
          const key = makeCronKey(id);
          cronManager.del(key);
          db.data.tasks.splice(idx, 1);
          await db.write();
          await msg.edit({
            text: `✅ 已删除任务 <code>${id}</code>`,
            parseMode: "html",
          });
          return;
        }

        if (sub === "disable" || sub === "enable") {
          const id = args[1];
          if (!id) {
            await msg.edit({
              text:
                sub === "disable"
                  ? `请提供定时任务ID: <code>${mainPrefix}acron disable ID</code>`
                  : `请提供定时任务ID: <code>${mainPrefix}acron enable ID</code>`,
              parseMode: "html",
            });
            return;
          }
          const db = await getDB();
          const idx = db.data.tasks.findIndex((t) => t.id === id);
          if (idx < 0) {
            await msg.edit({
              text: `未找到任务: <code>${id}</code>`,
              parseMode: "html",
            });
            return;
          }
          const t = db.data.tasks[idx];
          if (sub === "disable") {
            if (t.disabled) {
              await msg.edit({
                text: `任务 <code>${id}</code> 已处于禁用状态`,
                parseMode: "html",
              });
              return;
            }
            const key = makeCronKey(id);
            cronManager.del(key);
            t.disabled = true;
            await db.write();
            await msg.edit({
              text: `⏸️ 已禁用任务 <code>${id}</code>`,
              parseMode: "html",
            });
          } else {
            if (!cron.validateCronExpression(t.cron).valid) {
              await msg.edit({
                text: `任务 <code>${id}</code> 的 Cron 表达式无效，无法启用`,
                parseMode: "html",
              });
              return;
            }
            t.disabled = false;
            await db.write();
            await scheduleTask(t as AcronTask);
            const nextAt = cron.sendAt(t.cron);
            await msg.edit({
              text: `▶️ 已启用任务 <code>${id}</code>\n下次执行: ${formatDate(
                nextAt.toJSDate()
              )}`,
              parseMode: "html",
            });
          }
          return;
        }

        if (sub === "del" || sub === "del_re") {
          const argRest = args.slice(1); // 跳过子命令
          const parsed = parseCronFromArgs(argRest);
          if (!parsed) {
            await msg.edit({ text: "无效的 Cron 表达式（需6段）" });
            return;
          }
          const { cron: cronExpr, rest } = parsed;
          const validation = cron.validateCronExpression(cronExpr);
          if (!validation.valid) {
            await msg.edit({
              text: `Cron 校验失败: ${validation.error || "无效表达式"}`,
            });
            return;
          }

          const chatArg = rest[0];
          if (!chatArg) {
            await msg.edit({ text: "请提供对话ID或@name" });
            return;
          }
          // 解析并展示（失败也只用于展示）
          const { id: resolvedChatId, display } = await formatEntity(chatArg);
          const chatIdNum = Number(resolvedChatId);
          const hasChatId = Number.isFinite(chatIdNum)
            ? String(chatIdNum)
            : undefined;

          const db = await getDB();
          // 自增 seq（字符串存储）
          const currentSeq = toInt(db.data.seq) ?? 0;
          const nextSeq = currentSeq + 1;
          db.data.seq = String(nextSeq);
          const id = String(nextSeq);

          if (sub === "del") {
            const msgIdStr = rest[1];
            let msgId = Number(msgIdStr);
            if (!msgIdStr || Number.isNaN(msgId)) {
              // 如果未提供，尝试从回复中获取
              if (msg.isReply) {
                const replied = await msg.getReplyMessage();
                msgId = Number(replied?.id);
              }
            }
            if (!msgId || Number.isNaN(msgId)) {
              await msg.edit({ text: "请提供有效的消息ID，或回复一条消息" });
              return;
            }
            const remark = rest.slice(2).join(" ").trim();

            const task: DelTask = {
              id,
              type: "del",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId as any,
              msgId: String(Math.trunc(msgId)),
              createdAt: String(Date.now()),
              remark: remark || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = cron.sendAt(cronExpr);
            const tip = [
              "✅ 已添加删除消息的定时任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              `下次执行: ${formatDate(nextAt.toJSDate())}`,
              `复制: <code>${buildCopyCommand(task)}</code>`,
            ].join("\n");
            await msg.edit({ text: tip, parseMode: "html" });
            return;
          } else {
            // del_re
            const limitStr = rest[1];
            const limit = Number(limitStr || 100);
            if (!Number.isFinite(limit) || limit <= 0) {
              await msg.edit({ text: "请提供有效的条数限制(正整数)" });
              return;
            }
            if (!rest[2]) {
              await msg.edit({ text: "请提供消息正则表达式" });
              return;
            }
            // 新增备注支持：从第三段起第一个参数为正则，其余合并为备注
            const regexRaw = String(rest[2]).trim();
            const remark = rest.slice(3).join(" ").trim();
            if (!regexRaw) {
              await msg.edit({ text: "请提供消息正则表达式" });
              return;
            }
            // 校验正则
            try {
              void tryParseRegex(regexRaw);
            } catch (e: any) {
              await msg.edit({ text: `无效的正则表达式: ${e?.message || e}` });
              return;
            }

            const task: DelReTask = {
              id,
              type: "del_re",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId as any,
              limit: String(Math.trunc(limit)),
              regex: regexRaw,
              createdAt: String(Date.now()),
              remark: remark || undefined,
            };
            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = cron.sendAt(cronExpr);
            const tip = [
              "✅ 已添加正则删除的定时任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              `最近条数: <code>${limit}</code>`,
              `匹配: <code>${regexRaw}</code>`,
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              `下次执行: ${formatDate(nextAt.toJSDate())}`,
              `复制: <code>${buildCopyCommand(task)}</code>`,
            ].join("\n");
            await msg.edit({ text: tip, parseMode: "html" });
            return;
          }
        }

        await msg.edit({ text: `未知子命令: ${sub}` });
      } catch (error: any) {
        await msg.edit({ text: `处理出错: ${error?.message || error}` });
      }
    },
  };
}

export default new AcronPlugin();
