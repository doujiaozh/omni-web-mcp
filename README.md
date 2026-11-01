# Omni-Web-MCP

> **Omni-Web-MCP: let every web page be born as an AI playground.**
> **Omni-Web-MCP：让每一个网页，生来就是 AI 的游乐场。**

Zero-dependency, zero-build, single-file web MCP bridge. Drop **one `<script>`
tag** onto any page and that page instantly becomes remotely operable by an AI
agent: it can expose a numbered DOM snapshot, click, type and scroll — through
a local hub that speaks both **MCP (JSON-RPC)** and **OpenAI function calls**.

The whole stack is hand-written HTML/CSS/JS + Node.js standard library only.
No bundler, no `npm install`, no native modules — it even runs on Windows 7.

## ✨ Features

| | |
|---|---|
| **One-line injection** | `<script src="http://127.0.0.1:8787/omni-web-mcp.js"></script>` — that is all. |
| **Zero dependencies** | Client is a single IIFE; hub uses only `http/crypto/fs/path/os` (Node ≥ 14). |
| **5 core tools** | `list_pages`, `get_dom_tree`, `click_element`, `input_text`, `scroll_page`. |
| **Dual protocols** | MCP over stdio/HTTP for agents, OpenAI function-call JSON for LLM apps. |
| **Hand-rolled RFC6455** | The WebSocket server is implemented from scratch — no `ws` package. |
| **Pairing token** | 192-bit token, timing-safe compared, persisted with `0600` permissions. |
| **Privacy aware** | Password/secret fields masked, `privacy="strict"` masks everything, `data-omni-ignore` skips nodes. |
| **Resilient client** | 25 s heartbeat, exponential backoff reconnect, offline status badge (Shadow DOM). |

## 🏗️ Architecture

```
┌─────────────────┐   WebSocket    ┌─────────────────┐   stdio / HTTP   ┌──────────────┐
│  Any web page   │ ◄────────────► │   mcp-hub.js    │ ◄──────────────► │  AI agent    │
│ + mcp-client.js │  (hello/welcome) │  (Node, zero-dep) │ (MCP JSON-RPC /  │ (DSH, Claude, │
│                 │   (request/result) │                  │  OpenAI calls)   │  custom LLM)  │
└─────────────────┘                └─────────────────┘                  └──────────────┘
```

The browser page is the **tool provider**: the hub forwards an agent's tool
call to the page, the page executes it natively (real DOM click, real input
event) and returns the result upstream. No page ever talks to the outside
world directly — the hub runs on `127.0.0.1` and gates every session behind a
pairing token.

## 🚀 Quick start

```bash
# 1. Start the hub (any Node >= 14, Windows 7 friendly)
node mcp-hub.js                 # http://127.0.0.1:8787  (token auto-generated)

# 2. Open the demo page and attach it — it auto-pairs via the hub's origin
#    http://127.0.0.1:8787/demo/

# 3. Ask the agent to drive the page:
#    get_dom_tree → click_element(3) → input_text(1, "hello") → ...
```

Attach any page of yours with a single tag (hub serves the client itself):

```html
<script src="http://127.0.0.1:8787/omni-web-mcp.js"
        data-hub="http://127.0.0.1:8787" data-token="..." ></script>
```

Configuration is resolved from `data-*` attributes → `window.OMNI_WEB_MCP_CONFIG`
→ `?omni_hub=/&omni_token=` query params → `<meta name="omni-web-mcp-token">`.
Same-origin pages discover the token automatically from `GET /api/config.

### Token sources (highest priority first)

1. `--token <value>` CLI flag
2. `OMNI_WEB_MCP_TOKEN` environment variable
3. `.omni-web-mcp-token` file in the working directory
4. auto-generated 192-bit hex, persisted with `0600` permissions

## 🧰 Tools

| Tool | Arguments | Effect |
|---|---|---|
| `list_pages` | — | List every page currently paired with the hub. |
| `get_dom_tree` | `include_text`, `max_text`, `max_interactive`, `selector` | Numbered outline + interactive element map with roles/names. |
| `click_element` | `id` | Focus + real click on element `id`; reports navigation risk. |
| `input_text` | `id`, `text`, `submit` | Native `value` setter + `input`/`change` events; optional submit. |
| `scroll_page` | `direction`, `amount`, `element` | up/down/top/bottom/left/right, optionally inside element `id`. |

Fetch the machine-readable schemas:

```bash
curl http://127.0.0.1:8787/api/tools -H "Authorization: Bearer $TOKEN"   # OpenAI format
```

## 🤖 Agent integration

**MCP (stdio)** — point any MCP-compatible client at the hub:

```json
{ "mcpServers": { "omni-web-mcp": { "command": "node", "args": ["D:\\Code\\omni-web-mcp\\mcp-hub.js", "--stdio"] } } }
```

**HTTP / REST** — for LLM apps that use plain function calls:

```bash
curl http://127.0.0.1:8787/api/call -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"tool":"click_element","arguments":{"id":3}}'
curl http://127.0.0.1:8787/api/events -H "Authorization: Bearer $TOKEN"  # SSE stream
curl http://127.0.0.1:8787/mcp -H "Authorization: Bearer $TOKEN"         # MCP over HTTP POST
```

## 🔒 Security model

- The hub binds to `127.0.0.1` by default; every tool call requires the
  pairing token (`Authorization: Bearer` or `?token=`).
- Only same-origin browser pages can discover the token via `/api/config`.
- The client masks password/secret fields by default; set
  `data-privacy="strict"` to mask every value, or `data-omni-ignore` on any
  node to hide it from snapshots entirely.

## 🧪 Testing

```bash
node mcp-hub.js --port 8802 --token test-token-0123456789
node tests/e2e-run.js        # pairs with a live page via the hub REST API
```

## 📦 Layout

```
mcp-client.js      single-file injection client (served as /omni-web-mcp.js)
mcp-hub.js         local hub: hand-written RFC6455 server + MCP bridge
omni-web-mcp.js    CDN alias of mcp-client.js
demo/index.html    zero-dependency demo page (glassmorphism, todo list, console)
demo/favicon.svg
tests/e2e-run.js   end-to-end smoke test
```

## License

MIT — see [LICENSE](./LICENSE).

---

# 中文说明

> **Omni-Web-MCP：让每一个网页，生来就是 AI 的游乐场。**

零依赖、零构建、单文件的网页 MCP 桥接器。在任意网页引入**一行
`<script>`**，该网页就能立刻具备向 AI Agent 提供带编号的 DOM 结构、执行
点击、输入和滚动页面等能力；本地中转总线同时 speaks **MCP（JSON-RPC）**
与 **OpenAI function call** 两套协议。

整套技术栈只用原生 HTML/CSS/JS 与 Node.js 标准库手写，无打包工具、无
`npm install`、无原生模块 —— Windows 7 也能跑。

## ✨ 特性

| | |
|---|---|
| **一行注入** | `<script src="http://127.0.0.1:8787/omni-web-mcp.js"></script>` 即插即用。 |
| **零依赖** | 客户端是单文件 IIFE；hub 仅使用 `http/crypto/fs/path/os`（Node ≥ 14）。 |
| **5 个核心工具** | `list_pages`、`get_dom_tree`、`click_element`、`input_text`、`scroll_page`。 |
| **双协议** | 对 Agent 提供 stdio/HTTP 的 MCP，对 LLM 应用提供 OpenAI function-call JSON。 |
| **手写 RFC6455** | WebSocket 服务端从零实现，不依赖 `ws` 包。 |
| **配对令牌** | 192bit 令牌，恒定时间比对，以 `0600` 权限持久化。 |
| **隐私感知** | 密码/敏感字段自动掩码，`privacy="strict"` 掩全部值，`data-omni-ignore` 可跳过节点。 |
| **断线自愈** | 25 秒心跳、指数退避重连、Shadow DOM 状态胶囊。 |

## 🏗️ 架构

```
┌─────────────────┐   WebSocket    ┌─────────────────┐   stdio / HTTP   ┌──────────────┐
│   任意网页       │ ◄────────────► │   mcp-hub.js    │ ◄──────────────► │   AI Agent    │
│ + mcp-client.js │ （hello/welcome） │  （Node，零依赖） │ （MCP / OpenAI 调用） │（DSH、Claude、 │
│                 │ （request/result） │                  │                   │  自研 LLM 等）  │
└─────────────────┘                └─────────────────┘                  └──────────────┘
```

浏览器页面是**能力的提供方**：hub 把 Agent 的工具调用转发给页面，页面以
真实 DOM 点击/输入事件执行后回传结果。页面不直接对外通信 —— hub 只监听
`127.0.0.1`，且每个会话都必须通过配对令牌。

## 🚀 快速开始

```bash
# 1. 启动 hub（任意 Node >= 14，Win7 友好）
node mcp-hub.js                 # http://127.0.0.1:8787（令牌自动生成并落盘）

# 2. 打开演示页 demo/，同源自动配对：http://127.0.0.1:8787/demo/

# 3. 让 AI 操作页面：get_dom_tree → click_element(3) → input_text(1, "你好") → …
```

在自己页面里引入一行即可（客户端由 hub 直接提供）：

```html
<script src="http://127.0.0.1:8787/omni-web-mcp.js"
        data-hub="http://127.0.0.1:8787" data-token="..." ></script>
```

配置优先级：`data-*` 属性 → `window.OMNI_WEB_MCP_CONFIG` →
`?omni_hub=/&omni_token=` 查询参数 → `<meta name="omni-web-mcp-token">`。
同源页面会自动从 `GET /api/config` 发现令牌。

### 令牌来源（按优先级）

1. `--token <值>` 命令行参数
2. `OMNI_WEB_MCP_TOKEN` 环境变量
3. 工作目录下的 `.omni-web-mcp-token` 文件
4. 自动生成 192bit 十六进制令牌并以 `0600` 权限保存

## 🧰 工具清单

| 工具 | 参数 | 效果 |
|---|---|---|
| `list_pages` | — | 列出当前与 hub 配对的所有页面。 |
| `get_dom_tree` | `include_text`、`max_text`、`max_interactive`、`selector` | 带编号的页面大纲 + 交互元素表（含 role/name）。 |
| `click_element` | `id` | 聚焦并真实点击编号元素，返回是否可能导航。 |
| `input_text` | `id`、`text`、`submit` | 原生 value 赋值 + `input`/`change` 事件，可选提交。 |
| `scroll_page` | `direction`、`amount`、`element` | up/down/top/bottom/left/right，可指定容器元素 id。 |

获取机器可读的描述：

```bash
curl http://127.0.0.1:8787/api/tools -H "Authorization: Bearer $TOKEN"   # OpenAI 格式
```

## 🤖 Agent 接入

**MCP（stdio）** —— 让任意兼容 MCP 的客户端启动 hub：

```json
{ "mcpServers": { "omni-web-mcp": { "command": "node", "args": ["D:\\Code\\omni-web-mcp\\mcp-hub.js", "--stdio"] } } }
```

**HTTP / REST** —— 适合直接用 function call 的 LLM 应用：

```bash
curl http://127.0.0.1:8787/api/call -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"tool":"click_element","arguments":{"id":3}}'
curl http://127.0.0.1:8787/api/events -H "Authorization: Bearer $TOKEN"  # SSE 事件流
curl http://127.0.0.1:8787/mcp -H "Authorization: Bearer $TOKEN"         # MCP over HTTP
```

## 🔒 安全模型

- hub 默认只绑定 `127.0.0.1`；每次工具调用都需配对令牌（`Authorization:
  Bearer` 或 `?token=`）。
- 只有同源页面能通过 `/api/config` 发现令牌。
- 客户端默认掩码密码/敏感字段；`data-privacy="strict"` 掩全部值，
  `data-omni-ignore` 可让节点完全不进入快照。

## 🧪 测试

```bash
node mcp-hub.js --port 8802 --token test-token-0123456789
node tests/e2e-run.js        # 通过 hub REST API 与真实页面端到端冒烟
```

## 📦 目录结构

```
mcp-client.js      单文件注入客户端（hub 同时以 /omni-web-mcp.js 提供）
mcp-hub.js         本地中转总线：手写 RFC6455 服务端 + MCP 桥接
omni-web-mcp.js    mcp-client.js 的 CDN 别名
demo/index.html    零依赖演示页（玻璃拟态、待办列表、控制台）
demo/favicon.svg
tests/e2e-run.js   端到端冒烟脚本
```

## 开源

本项目以 MIT 协议开源，欢迎 Star / PR / Issue。推送命令见
[CONTRIBUTING 速查](#-开源推送)。

## 📤 开源推送

```bash
git init && git add -A && git commit -m "feat: Omni-Web-MCP - Zero-dependency web MCP bridge for AI agents"
git branch -M main
git remote add origin git@github.com:<你的用户名>/omni-web-mcp.git
git push -u origin main
```

## 协议

MIT —— 见 [LICENSE](./LICENSE)。
