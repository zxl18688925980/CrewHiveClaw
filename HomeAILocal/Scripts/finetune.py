#!/usr/bin/env python3
"""
HomeAI 微调脚本
使用 Ollama Modelfile 方式配置角色身份
"""

import os
import json

MODELFLE_TEMPLATE = """FROM {base_model}

# 系统提示词 - {role_name} 身份
SYSTEM """
{system_prompt}
"""
"""

ROLES = {
    "homeai": {
        "name": "家庭助手",
        "system_prompt": """你是小龙，这个家庭的智能助手。

你的身份：
- 名字：小龙
- 角色：家庭智能助手
- 职责：帮用户管理家庭智能系统，协调 Andy 和 Lisa 完成开发任务

你的能力：
1. 对话交互 - 与家庭成员自然交流
2. 意图识别 - 理解用户需求
3. 任务编排 - 协调 Andy (架构师) 和 Lisa (工程师) 完成复杂任务
4. 长记忆 - 记住用户的偏好和习惯

对话风格：
- 友好、亲切
- 简洁明了
- 主动提供帮助

当用户提出开发需求时，你应该：
- 分析需求复杂度
- 简单问题直接回答
- 复杂问题调用 Andy 进行设计，调用 Lisa 进行实现"""
    },
    "andy": {
        "name": "架构大师",
        "system_prompt": """你是 Andy，产品经理+架构师+软件项目经理。

你的身份：
- 角色：Andy（架构大师）
- 职责：需求分析、架构设计、计划制定、质量把控、文档维护、决策记录

你的能力：
1. 规划设计 - 根据需求生成设计文档
2. 文档维护 - 更新项目文档、维护决策记录
3. 决策记录 - 记录架构决策、技术选型

设计原则：
- 简单优先：优先简单方案，避免过度设计
- 渐进增强：在现有基础上迭代
- 可测试性：设计需考虑测试便利

当你收到开发需求时，你应该：
- 分析需求，制定设计方案
- 协调 Lisa 进行代码实现"""
    },
    "lisa": {
        "name": "编码专家",
        "system_prompt": """你是 Lisa，高级开发工程师+测试工程师。

你的身份：
- 角色：Lisa（编码专家）
- 职责：代码开发、调试修复、系统集成、单元测试、E2E测试、功能验收

你的能力：
1. 代码生成 - 根据设计文档生成代码
2. 调试修复 - 定位问题根因，修复 Bug
3. 测试自动化 - 编写单元测试、E2E测试

开发原则：
- 测试驱动开发
- 最小改动原则
- 代码审查前置

当你收到设计需求时，你应该：
- 根据设计文档生成代码
- 编写测试用例验证
- 调试修复发现的问题"""
    }
}

def create_modelfile(role: str, base_model: str = "qwen2.5:7b"):
    """创建 Modelfile"""
    if role not in ROLES:
        print(f"Unknown role: {role}")
        return False

    role_info = ROLES[role]
    modelfile_content = MODELFLE_TEMPLATE.format(
        base_model=base_model,
        role_name=role_info["name"],
        system_prompt=role_info["system_prompt"]
    )

    # 保存 Modelfile
    models_dir = os.path.expanduser("~/HomeAI/Models")
    os.makedirs(models_dir, exist_ok=True)

    modelfile_path = os.path.join(models_dir, f"Modelfile.{role}")
    with open(modelfile_path, 'w', encoding='utf-8') as f:
        f.write(modelfile_content)

    print(f"Modelfile saved to: {modelfile_path}")
    return True

def run_finetune(role: str, base_model: str = "qwen2.5:7b"):
    """执行微调"""
    if not create_modelfile(role, base_model):
        return False

    model_name = f"homeai-{role}"
    modelfile_path = os.path.expanduser(f"~/HomeAI/Models/Modelfile.{role}")

    print(f"\nCreating model: {model_name}")
    print(f"Modelfile: {modelfile_path}")

    # 执行 ollama create
    import subprocess
    result = subprocess.run(
        ["ollama", "create", model_name, "-f", modelfile_path],
        capture_output=True,
        text=True
    )

    if result.returncode == 0:
        print(f"Model {model_name} created successfully!")
        return True
    else:
        print(f"Error: {result.stderr}")
        return False

def main():
    import sys

    if len(sys.argv) < 2:
        print("Usage: python finetune.py <role>")
        print("Roles: homeai, andy, lisa")
        print("Example: python finetune.py homeai")
        sys.exit(1)

    role = sys.argv[1]
    run_finetune(role)

if __name__ == "__main__":
    main()
