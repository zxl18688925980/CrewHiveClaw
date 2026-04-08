#!/usr/bin/env python3
"""
微调数据准备脚本 - 将对话数据转换为微调格式
生成 JSONL 格式的训练数据
"""

import json
import os
import glob
from datetime import datetime

DIALOGUE_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'memory', 'dialogue')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'knowledge', 'corpus')

def load_dialogues():
    """加载所有对话数据"""
    dialogues = []
    pattern = os.path.join(DIALOGUE_DIR, "dialogue_*.json")

    for filepath in glob.glob(pattern):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                dialogues.append(json.load(f))
        except Exception as e:
            print(f"Error loading {filepath}: {e}")

    return dialogues

def convert_to_training_format(dialogue):
    """将对话转换为训练格式"""
    messages = dialogue.get('messages', [])

    # 构建对话文本
    conversation_text = ""
    for msg in messages:
        role = msg.get('role', 'unknown')
        content = msg.get('content', '')
        if role == 'system':
            conversation_text += f"System: {content}\n"
        elif role == 'user':
            conversation_text += f"User: {content}\n"
        elif role == 'assistant':
            conversation_text += f"Assistant: {content}\n"

    # 构建微调数据格式 (Alpaca 格式)
    # 查找最后一轮 user 和 assistant 对话
    user_msg = None
    assistant_msg = None

    for i, msg in enumerate(messages):
        if msg.get('role') == 'user':
            user_msg = msg.get('content', '')
        elif msg.get('role') == 'assistant' and user_msg:
            assistant_msg = msg.get('content', '')
            break

    if user_msg and assistant_msg:
        return {
            "instruction": user_msg,
            "input": "",
            "output": assistant_msg,
            "system": "你是小龙，这个家庭的智能助手。你可以帮用户管理家庭智能系统、协调 Andy 和 Lisa 完成开发任务。"
        }

    return None

def generate_training_data():
    """生成训练数据"""
    dialogues = load_dialogues()
    print(f"Loaded {len(dialogues)} dialogues")

    training_data = []
    for dialogue in dialogues:
        item = convert_to_training_format(dialogue)
        if item:
            training_data.append(item)

    print(f"Generated {len(training_data)} training items")

    # 保存为 JSONL 格式
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_file = os.path.join(OUTPUT_DIR, 'training_data.jsonl')

    with open(output_file, 'w', encoding='utf-8') as f:
        for item in training_data:
            f.write(json.dumps(item, ensure_ascii=False) + '\n')

    print(f"Training data saved to {output_file}")
    return training_data

def generate_system_prompt():
    """生成系统提示词用于基础微调"""
    system_prompt = """你是小龙，这个家庭的智能助手。你可以帮用户管理家庭智能系统、协调 Andy 和 Lisa 完成开发任务。

你的能力包括：
1. 对话交互 - 与家庭成员自然交流
2. 意图识别 - 理解用户需求
3. 任务编排 - 协调 Andy (架构师) 和 Lisa (工程师) 完成复杂任务
4. 长记忆 - 记住用户的偏好和习惯

当用户提出开发需求时，你应该：
- 分析需求复杂度
- 简单问题直接回答
- 复杂问题调用 Andy 进行设计，调用 Lisa 进行实现

你是谁：
- 你是这个家庭的智能助手
- 你的名字叫小龙
- 你服务于这个家庭的所有成员"""

    return system_prompt

if __name__ == '__main__':
    print("=== HomeAI 微调数据准备 ===")
    print(f"时间: {datetime.now().isoformat()}")
    print()

    # 生成训练数据
    training_data = generate_training_data()

    # 生成系统提示词
    system_prompt = generate_system_prompt()
    system_file = os.path.join(OUTPUT_DIR, 'system_prompt.txt')
    with open(system_file, 'w', encoding='utf-8') as f:
        f.write(system_prompt)
    print(f"System prompt saved to {system_file}")

    print("\n=== 完成 ===")
    print(f"训练数据条数: {len(training_data)}")
    print("下一步: 使用 unsloth 或 PEFT 进行模型微调")
