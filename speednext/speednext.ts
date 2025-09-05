/**
 * SpeedNext plugin for TeleBox - Network Speed Test
 * Converted from PagerMaid-Modify speednext.py
 */

import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { TelegramClient } from "telegram";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import axios from "axios";

// HTML escape function
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const execAsync = promisify(exec);
const ASSETS_DIR = createDirectoryInAssets("speedtest");
const SPEEDTEST_PATH = path.join(ASSETS_DIR, "speedtest");
const SPEEDTEST_JSON = path.join(ASSETS_DIR, "speedtest.json");
const SPEEDTEST_VERSION = "1.2.0";

interface SpeedtestResult {
  isp: string;
  server: {
    id: number;
    name: string;
    location: string;
  };
  interface: {
    externalIp: string;
    name: string;
  };
  ping: {
    latency: number;
    jitter: number;
  };
  download: {
    bandwidth: number;
    bytes: number;
  };
  upload: {
    bandwidth: number;
    bytes: number;
  };
  timestamp: string;
  result: {
    url: string;
  };
}

interface ServerInfo {
  id: number;
  name: string;
  location: string;
}

function ensureDirectories(): void {
  // createDirectoryInAssets already ensures directory exists
  // No additional action needed
}

function getDefaultServer(): number | null {
  try {
    if (fs.existsSync(SPEEDTEST_JSON)) {
      const data = JSON.parse(fs.readFileSync(SPEEDTEST_JSON, "utf8"));
      return data.default_server_id || null;
    }
  } catch (error: any) {
    console.error("Failed to read default server:", error);
  }
  return null;
}

function saveDefaultServer(serverId: number | null): void {
  try {
    ensureDirectories();
    fs.writeFileSync(
      SPEEDTEST_JSON,
      JSON.stringify({ default_server_id: serverId })
    );
  } catch (error: any) {
    console.error("Failed to save default server:", error);
  }
}

function removeDefaultServer(): void {
  try {
    if (fs.existsSync(SPEEDTEST_JSON)) {
      fs.unlinkSync(SPEEDTEST_JSON);
    }
  } catch (error: any) {
    console.error("Failed to remove default server:", error);
  }
}

async function downloadCli(): Promise<void> {
  try {
    ensureDirectories();

    // 检查是否已存在
    if (fs.existsSync(SPEEDTEST_PATH)) {
      return;
    }

    const platform = process.platform;
    const arch = process.arch;

    let filename: string;
    if (platform === "linux") {
      const archMap: { [key: string]: string } = {
        x64: "x86_64",
        arm64: "aarch64",
        arm: "armhf",
      };
      const mappedArch = archMap[arch] || "x86_64";
      filename = `ookla-speedtest-${SPEEDTEST_VERSION}-linux-${mappedArch}.tgz`;
    } else if (platform === "win32") {
      filename = `ookla-speedtest-${SPEEDTEST_VERSION}-win64.zip`;
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const url = `https://install.speedtest.net/app/cli/${filename}`;
    const response = await axios.get(url, { responseType: "arraybuffer" });

    const tempFile = path.join(ASSETS_DIR, filename);
    fs.writeFileSync(tempFile, response.data);

    // 解压文件
    if (platform === "linux") {
      await execAsync(`tar -xzf "${tempFile}" -C "${ASSETS_DIR}"`);
      await execAsync(`chmod +x "${SPEEDTEST_PATH}"`);
    } else if (platform === "win32") {
      // Windows 需要解压 zip 文件
      const AdmZip = require("adm-zip");
      const zip = new AdmZip(tempFile);
      zip.extractAllTo(ASSETS_DIR, true);
    }

    // 清理临时文件
    fs.unlinkSync(tempFile);

    // 清理额外文件
    const extraFiles = ["speedtest.5", "speedtest.md"];
    for (const file of extraFiles) {
      const filePath = path.join(ASSETS_DIR, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (error: any) {
    console.error("Failed to download speedtest CLI:", error);
    throw error;
  }
}

async function unitConvert(
  bytes: number,
  isBytes: boolean = false
): Promise<string> {
  const power = 1000;
  let value = bytes;
  let unitIndex = 0;

  const units = isBytes
    ? ["B", "KB", "MB", "GB", "TB"]
    : ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];

  if (!isBytes) {
    value *= 8; // Convert bytes to bits
  }

  while (value >= power && unitIndex < units.length - 1) {
    value /= power;
    unitIndex++;
  }

  return `${Math.round(value * 100) / 100}${units[unitIndex]}`;
}

async function getIpApi(ip: string): Promise<{
  asInfo: string;
  ccName: string;
  ccCode: string;
  ccFlag: string;
  ccLink: string;
}> {
  try {
    const response = await axios.get(
      `http://ip-api.com/json/${ip}?fields=as,country,countryCode`
    );
    const data = response.data;

    const asInfo = data.as?.split(" ")[0] || "";
    const ccName =
      data.country === "Netherlands" ? "Netherlands" : data.country || "";
    const ccCode = data.countryCode || "";
    const ccFlag = ccCode
      ? String.fromCodePoint(
          ...ccCode
            .toUpperCase()
            .split("")
            .map((c: string) => 127397 + c.charCodeAt(0))
        )
      : "";

    let ccLink = "https://www.submarinecablemap.com/country/";
    if (["Hong Kong", "Macao", "Macau"].includes(ccName)) {
      ccLink += "china";
    } else {
      ccLink += ccName.toLowerCase().replace(" ", "-");
    }

    return { asInfo, ccName, ccCode, ccFlag, ccLink };
  } catch (error: any) {
    console.error("Failed to get IP info:", error);
    return { asInfo: "", ccName: "", ccCode: "", ccFlag: "", ccLink: "" };
  }
}

async function getInterfaceTraffic(interfaceName: string): Promise<{
  rxBytes: number;
  txBytes: number;
  mtu: number;
}> {
  try {
    if (process.platform === "linux") {
      const rxBytes = parseInt(
        fs.readFileSync(
          `/sys/class/net/${interfaceName}/statistics/rx_bytes`,
          "utf8"
        )
      );
      const txBytes = parseInt(
        fs.readFileSync(
          `/sys/class/net/${interfaceName}/statistics/tx_bytes`,
          "utf8"
        )
      );
      const mtu = parseInt(
        fs.readFileSync(`/sys/class/net/${interfaceName}/mtu`, "utf8")
      );
      return { rxBytes, txBytes, mtu };
    }
  } catch (error: any) {
    console.error("Failed to get interface traffic:", error);
  }
  return { rxBytes: 0, txBytes: 0, mtu: 0 };
}

async function runSpeedtest(serverId?: number): Promise<SpeedtestResult> {
  try {
    if (!fs.existsSync(SPEEDTEST_PATH)) {
      await downloadCli();
    }

    const serverArg = serverId ? ` -s ${serverId}` : "";
    const command = `"${SPEEDTEST_PATH}" --accept-license --accept-gdpr -f json${serverArg}`;

    const { stdout, stderr } = await execAsync(command);

    if (stderr && stderr.includes("NoServersException")) {
      throw new Error("Unable to connect to the specified server");
    }

    return JSON.parse(stdout);
  } catch (error: any) {
    console.error("Speedtest failed:", error);
    throw error;
  }
}

async function getAllServers(): Promise<ServerInfo[]> {
  try {
    if (!fs.existsSync(SPEEDTEST_PATH)) {
      await downloadCli();
    }

    const command = `"${SPEEDTEST_PATH}" -f json -L`;
    const { stdout } = await execAsync(command);
    const result = JSON.parse(stdout);

    return result.servers || [];
  } catch (error: any) {
    console.error("Failed to get servers:", error);
    return [];
  }
}

async function saveSpeedtestImage(url: string): Promise<string | null> {
  try {
    const imageUrl = url + ".png";
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });

    const tempDir = createDirectoryInAssets("temp");
    const imagePath = path.join(tempDir, "speedtest.png");
    fs.writeFileSync(imagePath, response.data);

    return imagePath;
  } catch (error: any) {
    console.error("Failed to save speedtest image:", error);
    return null;
  }
}

const speedtest = async (msg: Api.Message) => {
  const args = msg.message.slice(1).split(" ").slice(1);
  const command = args[0] || "";

  try {
    if (command === "list") {
      await msg.edit({ text: "🔍 正在获取服务器列表...", parseMode: "html" });

      const servers = await getAllServers();
      if (servers.length === 0) {
        await msg.edit({
          text: "❌ <b>错误</b>\n\n无可用服务器",
          parseMode: "html",
        });
        return;
      }

      const serverList = servers
        .slice(0, 20)
        .map(
          (server) =>
            `<code>${server.id}</code> - <code>${htmlEscape(
              server.name
            )}</code> - <code>${htmlEscape(server.location)}</code>`
        )
        .join("\n");

      await msg.edit({
        text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n${serverList}`,
        parseMode: "html",
      });
    } else if (command === "set") {
      const serverId = parseInt(args[1]);
      if (!serverId || isNaN(serverId)) {
        await msg.edit({
          text: "❌ <b>参数错误</b>\n\n请指定有效的服务器ID\n例: <code>s set 12345</code>",
          parseMode: "html",
        });
        return;
      }

      saveDefaultServer(serverId);
      await msg.edit({
        text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n<code>默认服务器已设置为 ${serverId}</code>`,
        parseMode: "html",
      });
    } else if (command === "clear") {
      removeDefaultServer();
      await msg.edit({
        text: "<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n<code>默认服务器已清除</code>",
        parseMode: "html",
      });
    } else if (command === "config") {
      const defaultServer = getDefaultServer() || "Auto";
      await msg.edit({
        text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n<code>默认服务器: ${defaultServer}</code>\n<code>Speedtest® CLI: ${SPEEDTEST_VERSION}</code>`,
        parseMode: "html",
      });
    } else if (command === "update") {
      await msg.edit({
        text: "🔄 正在更新 Speedtest CLI...",
        parseMode: "html",
      });

      try {
        // 删除现有文件强制重新下载
        if (fs.existsSync(SPEEDTEST_PATH)) {
          fs.unlinkSync(SPEEDTEST_PATH);
        }

        await downloadCli();
        await msg.edit({
          text: "<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n<code>Speedtest® CLI 已更新到最新版本</code>",
          parseMode: "html",
        });
      } catch (error) {
        await msg.edit({
          text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n<code>更新失败: ${htmlEscape(
            String(error)
          )}</code>`,
          parseMode: "html",
        });
      }
    } else if (command === "" || !isNaN(parseInt(command))) {
      await msg.edit({ text: "⚡️ 正在进行速度测试...", parseMode: "html" });

      const serverId =
        command && !isNaN(parseInt(command))
          ? parseInt(command)
          : getDefaultServer();

      try {
        const result = await runSpeedtest(serverId || undefined);
        const { asInfo, ccName, ccCode, ccFlag, ccLink } = await getIpApi(
          result.interface.externalIp
        );
        const { rxBytes, txBytes, mtu } = await getInterfaceTraffic(
          result.interface.name
        );

        const description = [
          `<blockquote><b>⚡️SPEEDTEST by OOKLA @${ccCode}${ccFlag}</b></blockquote>`,
          `<code>Name</code>  <code>${htmlEscape(result.isp)}</code> ${asInfo}`,
          `<code>Node</code>  <code>${
            result.server.id
          }</code> - <code>${htmlEscape(
            result.server.name
          )}</code> - <code>${htmlEscape(result.server.location)}</code>`,
          `<code>Conn</code>  <code>${
            result.interface.externalIp.includes(":") ? "IPv6" : "IPv4"
          }</code> - <code>${htmlEscape(
            result.interface.name
          )}</code> - <code>MTU</code> <code>${mtu}</code>`,
          `<code>Ping</code>  <code>⇔${result.ping.latency}ms</code> <code>±${result.ping.jitter}ms</code>`,
          `<code>Rate</code>  <code>↓${await unitConvert(
            result.download.bandwidth
          )}</code> <code>↑${await unitConvert(
            result.upload.bandwidth
          )}</code>`,
          `<code>Data</code>  <code>↓${await unitConvert(
            result.download.bytes,
            true
          )}</code> <code>↑${await unitConvert(
            result.upload.bytes,
            true
          )}</code>`,
          `<code>Stat</code>  <code>RX ${await unitConvert(
            rxBytes,
            true
          )}</code> <code>TX ${await unitConvert(txBytes, true)}</code>`,
          `<code>Time</code>  <code>${result.timestamp
            .replace("T", " ")
            .split(".")[0]
            .replace("Z", "")}</code>`,
        ].join("\n");

        // 尝试发送图片
        if (result.result?.url) {
          try {
            const imagePath = await saveSpeedtestImage(result.result.url);
            if (imagePath && fs.existsSync(imagePath)) {
              await msg.client?.sendFile(msg.peerId, {
                file: imagePath,
                caption: description,
                parseMode: "html",
              });

              // 删除原消息和临时文件
              await msg.delete();
              fs.unlinkSync(imagePath);
              return;
            }
          } catch (imageError) {
            console.error("Failed to send image:", imageError);
          }
        }

        // 如果图片发送失败，发送文本
        await msg.edit({ text: description, parseMode: "html" });
      } catch (error) {
        await msg.edit({
          text: `❌ <b>速度测试失败</b>\n\n<code>${htmlEscape(
            String(error)
          )}</code>`,
          parseMode: "html",
        });
      }
    } else {
      await msg.edit({
        text: `❌ <b>参数错误</b>\n\n<b>使用方法:</b>
<code>s</code> - 开始速度测试
<code>s [服务器ID]</code> - 使用指定服务器测试
<code>s list</code> - 显示可用服务器列表
<code>s set [ID]</code> - 设置默认服务器
<code>s clear</code> - 清除默认服务器
<code>s config</code> - 显示配置信息
<code>s update</code> - 更新 Speedtest CLI`,
        parseMode: "html",
      });
    }
  } catch (error: any) {
    console.error("SpeedNext plugin error:", error);
    const errorMessage = error.message || String(error);
    const displayError =
      errorMessage.length > 100
        ? errorMessage.substring(0, 100) + "..."
        : errorMessage;
    await msg.edit({
      text: `❌ <b>插件错误</b>\n\n<b>错误信息:</b> <code>${htmlEscape(
        displayError
      )}</code>\n\n💡 <b>建议:</b> 请检查网络连接或联系管理员`,
      parseMode: "html",
    });
  }
};

class SpeednextPlugin extends Plugin {
  description: string = `⚡️ 网络速度测试工具 | SpeedTest by Ookla`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    speedtest,
    s: speedtest,
  };
}

export default new SpeednextPlugin();
