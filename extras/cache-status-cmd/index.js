"use strict";

const path = require("path");
const { execSync } = require("child_process");

const plugin = {
  id: "cache-status-cmd",
  name: "Cache Status",
  description: "查看缓存预热代理状态的斜杠命令",

  register(api) {
    api.registerCommand({
      name: "cache",
      description: "查看缓存预热代理状态（零模型成本）",
      acceptsArgs: false,
      requireAuth: true,
      async handler(ctx) {
        try {
          // 脚本路径相对于插件目录
          const scriptPath = path.join(__dirname, "cache-status");
          const output = execSync(scriptPath, {
            timeout: 5000,
            encoding: "utf-8",
          });
          return { text: output };
        } catch (err) {
          return { text: `❌ 查询失败: ${err.message}` };
        }
      },
    });
  },
};

module.exports = plugin;
module.exports.default = plugin;
