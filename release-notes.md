# 本次改动

- 新增默认搜索渠道 Exa（`https://mcp.exa.ai/mcp`），免费、不需要 API Key
- 设置 → 通用 → 联网搜索默认选中 Exa；仍可切换 DeepSeek / Tavily
- 搜索开关不再依赖 DeepSeek Key：选 Exa 时开箱即用

打开搜索后，提问会走 Exa 的 web_search_exa 检索，并把结果作为资料注入上下文。
