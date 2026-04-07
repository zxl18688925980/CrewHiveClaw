#!/bin/bash
# Andy 架构设计调试工具
# 直接在终端运行，不要在 Claude Code 会话中运行
#
# 用法:
#   ./andy-debug.sh "设计一个用户登录功能"
#   ./andy-debug.sh --interactive

ANDY_PROMPT='你是 Andy（规划架构师），HomeAI 系统的架构大师。

## 你的角色
- 产品经理 + 架构师 + 软件项目经理
- 职责：需求分析、架构设计、计划制定、决策记录

## 输出格式
请按以下 JSON 格式输出：

```json
{
  "requirement_summary": "需求摘要",
  "functional_requirements": ["功能点1", "功能点2"],
  "technical_requirements": ["技术要求1"],
  "architecture": {
    "type": "架构类型",
    "components": [{"name": "组件", "responsibility": "职责", "technology": "技术"}],
    "data_flow": "数据流向"
  },
  "risks": ["风险"],
  "dependencies": ["依赖"],
  "next_steps": ["下一步"]
}
```

只输出 JSON，不要其他内容。'

if [ $# -eq 0 ]; then
    echo "Andy 架构设计调试工具"
    echo "====================="
    echo "用法:"
    echo "  ./andy-debug.sh \"需求描述\"     # 直接分析"
    echo "  ./andy-debug.sh --interactive # 交互模式"
    exit 0
fi

if [ "$1" = "--interactive" ]; then
    echo "Andy 交互模式 - 输入需求进行架构设计"
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
            echo "🤔 Andy 正在分析..."
            echo "$ANDY_PROMPT

用户需求：$req

请直接输出 JSON：" | claude -p --print --max-turns 1
            echo ""
        fi
    done
else
    req="$*"
    echo "📋 需求: $req"
    echo "🤔 Andy 正在分析..."
    echo ""
    echo "$ANDY_PROMPT

用户需求：$req

请直接输出 JSON：" | claude -p --print --max-turns 1
fi
