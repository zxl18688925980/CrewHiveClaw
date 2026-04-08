#!/bin/bash
# Lisa 代码实现调试工具
# 直接在终端运行，不要在 Claude Code 会话中运行
#
# 用法:
#   ./lisa-debug.sh "实现一个用户登录功能"
#   ./lisa-debug.sh --interactive

LISA_PROMPT='你是 Lisa（编码专家），HomeAI 系统的实现大师。

## 你的角色
- 高级开发工程师 + 测试工程师
- 职责：代码开发、调试修复、系统集成、测试

## 输出格式
请按以下 JSON 格式输出：

```json
{
  "files": [
    {"path": "文件路径", "action": "create/update", "content": "代码内容"}
  ],
  "tests": [{"path": "测试路径", "content": "测试代码"}],
  "verification": {"steps": ["验证步骤"], "expected": "预期结果"},
  "notes": ["备注"]
}
```

只输出 JSON，保持代码简洁实用。'

if [ $# -eq 0 ]; then
    echo "Lisa 代码实现调试工具"
    echo "====================="
    echo "用法:"
    echo "  ./lisa-debug.sh \"实现需求\"     # 直接实现"
    echo "  ./lisa-debug.sh --interactive # 交互模式"
    exit 0
fi

if [ "$1" = "--interactive" ]; then
    echo "Lisa 交互模式 - 输入实现需求"
    echo "输入 quit 退出"
    echo ""
    while true; do
        read -p "需求> " req
        if [ "$req" = "quit" ] || [ "$req" = "exit" ]; then
            echo "退出"
            break
        fi
        if [ -n "$req" ]; then
            echo ""
            echo "💻 Lisa 正在编码..."
            echo "$LISA_PROMPT

实现需求：$req

请直接输出 JSON：" | claude -p --print --max-turns 1
            echo ""
        fi
    done
else
    req="$*"
    echo "📋 实现需求: $req"
    echo "💻 Lisa 正在编码..."
    echo ""
    echo "$LISA_PROMPT

实现需求：$req

请直接输出 JSON：" | claude -p --print --max-turns 1
fi
