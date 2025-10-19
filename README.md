# 黄金价格监视器

一个基于 Node.js 的轻量级黄金行情看板：现价与 K 线都使用 OKX XAUT/USDT 现货数据源，前端嵌入类 ChatGPT 对话框，可结合实时行情与最近 120 根 K 线提供分析。

## 功能概览

- 实时价格卡片：以页面加载时的价格作为基准，显示当前价、涨跌值与涨跌幅，每 1 分钟刷新一次。
- 可切换周期的 K 线图（Lightweight Charts）：默认每分钟拉取新数据，并将最新 120 根蜡烛传递给聊天助手。
- 智能分析助手：接入 OpenAI Chat Completions API，结合最新行情与 K 线回答用户问题。
- Express 后端：提供 `/api` 接口、静态资源服务，并支持可选的 HTTPS 部署。

## 环境要求

- Node.js 20 或更新版本（依赖内置的 `fetch` 与 `AbortController`）。
- npm（随 Node.js 安装提供）。
- OpenAI API Key（启用聊天助手所需）。

## Debian 安装指南

> 以下步骤以 Debian 12 且拥有 sudo 权限为例，如在其他发行版请按需调整。

1. **更新系统并安装基础依赖**
   ```bash
   sudo apt-get update
   sudo apt-get install -y curl ca-certificates gnupg
   ```

2. **安装 Node.js 20（NodeSource 官方仓库）**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs

   # 可选：验证版本
   node -v
   npm -v
   ```

3. **获取代码**
   ```bash
   git clone https://github.com/<your-account>/gold.git
   cd gold
   ```

4. **安装依赖**
   ```bash
   npm install
   ```

5. **配置环境变量**
   ```bash
   cp .env.example .env
   nano .env   # 或使用您偏好的编辑器
   ```
   - `OPENAI_API_KEY`：必填，用于调用 OpenAI 接口  
   - `OPENAI_MODEL`、`OPENAI_BASE_URL`、`OKX_INSTRUMENT`：可选覆盖默认值  
   - `HTTPS_PORT`：HTTPS 监听端口，默认 `3443`，可改为 `443`  
   - `TLS_KEY_FILE`、`TLS_CERT_FILE`：提供后自动启用 HTTPS，支持相对或绝对路径  
   - `TLS_CA_FILE`、`TLS_PASSPHRASE`：可选项，适用于多级证书或有私钥密码时  
   - `PORT`：仅在需要额外开启 HTTP 服务时设置（默认关闭，建议保持仅 HTTPS）

6. **启动服务**
   ```bash
   npm run start
   ```
   若已配置证书，可直接访问 `https://localhost:3443`（或自定义端口）。如未配置 TLS 且未设置 `PORT`，服务将提示未启用任何监听。

7. **开发模式（可选）**
   ```bash
   npm run dev
   ```
   使用 `nodemon` 自动重启后端，便于调试。

## TLS 配置指南

同时提供 `TLS_KEY_FILE` 与 `TLS_CERT_FILE` 时，服务会在 `HTTPS_PORT` 上启动 HTTPS。证书路径可为绝对路径，也可相对项目根目录。

### 在 Debian 上使用 Certbot 申请证书

1. **安装 Certbot**
   ```bash
   sudo apt-get update
   sudo apt-get install -y certbot
   ```

2. **使用 standalone 模式申请证书（需保证 80 端口可访问）**
   ```bash
   sudo certbot certonly --standalone -d your-domain.com
   ```
   证书文件默认保存在 `/etc/letsencrypt/live/your-domain.com/`：
   - `privkey.pem`：私钥  
   - `fullchain.pem`：完整证书链（证书 + 中间证书）  
   - `chain.pem`：中间证书

3. **更新 `.env` 启用 HTTPS**
   ```env
   TLS_KEY_FILE=/etc/letsencrypt/live/your-domain.com/privkey.pem
   TLS_CERT_FILE=/etc/letsencrypt/live/your-domain.com/fullchain.pem
   TLS_CA_FILE=/etc/letsencrypt/live/your-domain.com/chain.pem
   HTTPS_PORT=443
   ```
   保存后重新启动服务：`npm run start`。

4. **证书续期**
   Certbot 默认会配置定时续期。可通过以下命令检查：
   ```bash
   sudo certbot renew --dry-run
   ```

## 常见问题

- **价格或 K 线未更新**：请确认服务器可访问 `https://www.okx.com`。在 Windows 环境下本项目会回退到 PowerShell 请求；Linux 环境如受防火墙或代理限制需自行配置。
- **聊天接口返回 500**：确认 `.env` 中已填入 `OPENAI_API_KEY`，且服务器能访问 OpenAI。
- **切换交易品种**：设置 `OKX_INSTRUMENT=BTC-USDT` 等即可更换 OKX 现货交易对，同时注意更新前端文案。

## 许可证

项目未附带许可证，若计划公开分发请自行添加合适的 License。
