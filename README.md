# Omni-Web-MCP

**Turn any web page into an AI playground — in one line.**

Zero-dependency, zero-build, single-file MCP bridge for Claude Desktop, Cursor, Windsurf, and any MCP-compatible agent.

⭐ **Star this repo** if you want AI to stop asking you to "copy-paste the page content".

## ✨ Why Omni-Web-MCP?

Most MCP servers require:
- `npm install` of 10+ heavy dependencies (puppeteer, ws, etc.)
- Complex configuration files
- A running Chrome instance

Omni-Web-MCP is different:
- **Zero dependencies** — client is a single IIFE; hub uses only Node built-ins (Node ≥ 14).
- **Windows 7 friendly** — runs on any old machine.
- **Dual protocols** — MCP over stdio/HTTP + OpenAI function-call JSON.
- **Privacy-first** — password fields masked, `data-omni-ignore` skips sensitive nodes.
- **Enterprise-grade security** — 192-bit pairing token, timing-safe comparison.

## 🚀 60-Second Quick Start

### Step 1: Start the hub
Since the package is not yet published to NPM, you can run it directly from GitHub:
```bash
npx -y github:doujiaozh/omni-web-mcp
# or
node mcp-hub.js
# Hub runs at http://127.0.0.1:8787
```

### Step 2: Connect your AI agent

#### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "omni-web": {
      "command": "npx",
      "args": ["-y", "github:doujiaozh/omni-web-mcp"]
    }
  }
}
```

#### Cursor (`~/.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "omni-web": {
      "command": "npx",
      "args": ["-y", "github:doujiaozh/omni-web-mcp"]
    }
  }
}
```

### Step 3: Attach a web page
Open any page you want the AI to interact with, and inject:
```html
<script src="http://127.0.0.1:8787/client.js"></script>
```
The page auto-pairs with the hub. The AI can now:
- `get_dom_tree` — see the page structure
- `click_element` — click buttons
- `input_text` — fill forms
- `scroll_page` — navigate

## 🛠️ 5 Core Tools

| Tool | What it does |
|------|--------------|
| `list_pages` | See all paired pages |
| `get_dom_tree` | Get numbered outline + interactive elements |
| `click_element` | Click any element by ID |
| `input_text` | Fill inputs and submit |
| `scroll_page` | Scroll the page |

## 🔒 Security & Privacy

- **Pairing token**: 192-bit, timing-safe compared, persisted with `0600` permissions.
- **Privacy masking**: Password fields are automatically masked. Use `privacy="strict"` to mask everything. Use `data-omni-ignore` to skip specific nodes.
- **Local-only**: The hub runs on `127.0.0.1`. No data leaves your machine.

## 📄 License

MIT
