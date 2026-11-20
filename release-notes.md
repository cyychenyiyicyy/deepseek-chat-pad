# 本次改动

- 更新弹窗新增「跳过此版本」与「启动时自动检查」开关
- 只在网页有变化时不再催更 APK：CI 会比较 android/ 目录，没动原生代码就只提示更新网页
- 第三方多模态模型支持图片上传：图片由客户端转成 data URL 直接发送，不再要求 DeepSeek 模型
- 新增 Tavily 搜索渠道：设置里可在 DeepSeek / Tavily 之间切换，Tavily 填自己的 Key
