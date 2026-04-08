#!/usr/bin/env python3
"""
HomeAI 模型微调脚本 - 使用 DeepSeek-R1-14B
使用 transformers + PEFT 进行 LoRA 微调
"""

import os
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, DataCollatorForLanguageModeling
from peft import LoraConfig, get_peft_model, TaskType, PeftModel
from datasets import Dataset
import json
from pathlib import Path

# 配置
MODEL_NAME = "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B"  # 使用蒸馏版，更适合 Mac
OUTPUT_DIR = Path("/Users/xinbinanshan/HomeAI/Models/finetuned_deepseek_r1")
TRAINING_FILE = Path("/Users/xinbinanshan/HomeAI/Data/knowledge/corpus/deepseek_r1_finetune.jsonl")


def load_training_data():
    """加载训练数据"""
    data = []
    with open(TRAINING_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            item = json.loads(line)
            # 转换为 messages 格式
            if 'messages' in item:
                # 使用 DeepSeek 格式
                messages = item['messages']
                text = "<｜begin_of_text｜>"
                for msg in messages:
                    role = msg['role']
                    content = msg['content']
                    if role == 'system':
                        text += f"<｜system｜>\n{content}<｜end_of_text｜>"
                    elif role == 'user':
                        text += f"<｜user｜>\n{content}<｜end_of_text｜>"
                    elif role == 'assistant':
                        text += f"<｜assistant｜>\n{content}<｜end_of_text｜>"
                data.append({"text": text})
    return data


def main():
    print("=" * 60)
    print("HomeAI 模型微调 (DeepSeek-R1-14B)")
    print("=" * 60)
    print()

    # 检查设备
    if torch.backends.mps.is_available():
        device = "mps"
        print("使用设备: Apple MPS (Metal Performance Shaders)")
    elif torch.cuda.is_available():
        device = "cuda"
        print("使用设备: NVIDIA GPU")
    else:
        device = "cpu"
        print("使用设备: CPU")
        print("警告: CPU 训练非常慢，建议使用 MPS 或 GPU")

    print(f"模型: {MODEL_NAME}")
    print()

    # 加载 tokenizer
    print("正在加载 tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, trust_remote_code=True)
    tokenizer.pad_token = tokenizer.eos_token
    tokenizer.chat_template = None  # 使用自定义格式

    # 加载模型 - 使用 bfloat16 和自动 device map
    print("正在加载模型 (这可能需要几分钟)...")
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_NAME,
        torch_dtype=torch.bfloat16,
        device_map="auto",
        trust_remote_code=True,
    )

    # 配置 LoRA
    print("正在配置 LoRA...")
    lora_config = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=16,
        lora_alpha=16,
        lora_dropout=0.05,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        bias="none",
    )

    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    # 加载训练数据
    print(f"正在加载训练数据: {TRAINING_FILE}")
    raw_data = load_training_data()
    print(f"加载了 {len(raw_data)} 条训练数据")

    # Tokenize
    def tokenize_function(examples):
        return tokenizer(examples["text"], truncation=True, max_length=2048)

    dataset = Dataset.from_dict({"text": [item["text"] for item in raw_data]})
    dataset = dataset.map(tokenize_function, batched=True, remove_columns=["text"])

    # Data collator
    data_collator = DataCollatorForLanguageModeling(
        tokenizer=tokenizer,
        mlm=False,
    )

    # 训练参数
    training_args = TrainingArguments(
        output_dir=str(OUTPUT_DIR),
        num_train_epochs=3,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=4,
        learning_rate=2e-4,
        bf16=True,
        logging_steps=1,
        save_strategy="epoch",
        save_total_limit=1,
        report_to="none",
        warmup_steps=10,
    )

    # 使用 Trainer
    from transformers import Trainer

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=dataset,
        data_collator=data_collator,
    )

    print()
    print("开始训练...")
    print(f"注意: 14B 模型训练可能需要较长时间")
    print()

    # 开始训练
    trainer.train()

    # 保存
    print("正在保存模型...")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(OUTPUT_DIR / "lora_adapter"))
    tokenizer.save_pretrained(str(OUTPUT_DIR / "lora_adapter"))

    print()
    print("=" * 60)
    print("✅ 微调完成!")
    print(f"📁 保存到: {OUTPUT_DIR / 'lora_adapter'}")
    print("=" * 60)
    print()
    print("下一步: 合并 LoRA 到模型")
    print("命令: python scripts/merge_lora.py")

if __name__ == "__main__":
    main()
