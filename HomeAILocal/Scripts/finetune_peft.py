#!/usr/bin/env python3
"""
HomeAI 模型微调脚本
使用 transformers + PEFT 进行 QLoRA 微调
支持 Apple Silicon (MPS)
"""

import os
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, DataCollatorForLanguageModeling
from peft import LoraConfig, get_peft_model, TaskType
from datasets import Dataset
import json
from pathlib import Path

# 配置
MODEL_NAME = "Qwen/Qwen2.5-7B-Instruct"
OUTPUT_DIR = Path("/Users/xinbinanshan/HomeAI/models/finetuned")
TRAINING_FILE = Path("/Users/xinbinanshan/HomeAI/data/knowledge/corpus/readme_finetune.jsonl")

# 启用 MPS
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"

def load_training_data():
    """加载训练数据"""
    data = []
    with open(TRAINING_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            data.append(json.loads(line))
    return data

def format_prompt(item):
    """格式化训练数据"""
    system = item.get('system', '')
    instruction = item.get('instruction', '')
    input_text = item.get('input', '')
    output = item.get('output', '')

    if input_text:
        text = f"""<|begin_of_text|><|start_header_id|>system<|end_header_id|>

{system}<|eot_id|><|start_header_id|>user<|end_header_id|>

{instruction}

{input_text}<|eot_id|><|start_header_id|>assistant<|end_header_id|>

{output}<|eot_id|>"""
    else:
        text = f"""<|begin_of_text|><|start_header_id|>system<|end_header_id|>

{system}<|eot_id|><|start_header_id|>user<|end_header_id|>

{instruction}<|eot_id|><|start_header_id|>assistant<|end_header_id|>

{output}<|eot_id|>"""

    return {"text": text}

def main():
    print("=" * 60)
    print("HomeAI 模型微调 (PEFT + QLoRA)")
    print("=" * 60)
    print()

    # 检查设备
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"使用设备: {device}")
    print()

    # 加载 tokenizer
    print("正在加载 tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, trust_remote_code=True)

    # 加载模型（4-bit 量化需要 bitsandbytes，但 MPS 不支持）
    # 使用 fp16
    print("正在加载模型 (这可能需要几分钟)...")
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_NAME,
        torch_dtype=torch.float16,
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
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        bias="none",
    )

    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    # 加载训练数据
    print(f"正在加载训练数据: {TRAINING_FILE}")
    raw_data = load_training_data()
    print(f"加载了 {len(raw_data)} 条训练数据")

    # 格式化数据
    train_texts = [format_prompt(item)["text"] for item in raw_data]

    # Tokenize
    def tokenize_function(examples):
        return tokenizer(examples["text"], truncation=True, max_length=2048)

    dataset = Dataset.from_dict({"text": train_texts})
    dataset = dataset.map(tokenize_function, batched=True, remove_columns=["text"])

    # Data collator
    data_collator = DataCollatorForLanguageModeling(
        tokenizer=tokenizer,
        mlm=False,  # 因果语言模型
    )

    # 训练参数
    training_args = TrainingArguments(
        output_dir=str(OUTPUT_DIR),
        num_train_epochs=3,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=4,
        learning_rate=2e-4,
        fp16=True,
        logging_steps=1,
        save_strategy="epoch",
        save_total_limit=1,
        report_to="none",
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
    print("⚠️ 注意: 14B 模型在 Mac 上可能非常慢")
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

if __name__ == "__main__":
    main()
