#!/usr/bin/env python3
"""
HomeAI 模型微调脚本
使用 Unsloth 进行 QLoRA 高效微调
"""

from unsloth import FastLanguageModel
import torch
import json
from pathlib import Path

# 配置
MODEL_NAME = "Qwen/Qwen2.5-7B-Instruct"  # 使用更小的蒸馏模型
OUTPUT_DIR = Path("/Users/xinbinanshan/HomeAI/models/finetuned")
TRAINING_FILE = Path("/Users/xinbinanshan/HomeAI/data/knowledge/corpus/readme_finetune.jsonl")

# 微调参数
MAX_seq_LENGTH = 2048
LOAD_IN_4_BIT = True
R = 16
LORA_ALPHA = 16
LORA_DROPOUT = 0.05
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]

def load_training_data():
    """加载训练数据"""
    data = []
    with open(TRAINING_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            data.append(json.loads(line))
    return data

def format_prompt(item):
    """格式化训练数据为指令微调格式"""
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
    print("HomeAI 模型微调")
    print("=" * 60)
    print()

    # 检查 MPS 可用性
    print(f"PyTorch 版本: {torch.__version__}")
    print(f"MPS 加速: {torch.backends.mps.is_available()}")
    print()

    # 加载模型
    print("正在加载模型...")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=MODEL_NAME,
        max_seq_length=MAX_seq_LENGTH,
        dtype=None,  # 自动检测
        load_in_4bit=LOAD_IN_4_BIT,
    )

    # 添加 LoRA adapter
    print("正在配置 LoRA...")
    model = FastLanguageModel.get_peft_model(
        model,
        r=R,
        target_modules=TARGET_MODULES,
        lora_alpha=LORA_ALPHA,
        lora_dropout=LORA_DROPOUT,
        bias="none",
        task_type="CAUSAL_LM",
    )

    # 加载训练数据
    print(f"正在加载训练数据: {TRAINING_FILE}")
    raw_data = load_training_data()
    print(f"加载了 {len(raw_data)} 条训练数据")

    # 格式化数据
    train_data = [format_prompt(item) for item in raw_data]

    # 使用 SFTTrainer
    from trl import SFOTrainer
    from transformers import TrainingArguments

    trainer = SFOTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=train_data,
        dataset_text_field="text",
        max_seq_length=MAX_seq_LENGTH,
        dataset_num_proc=2,
        packing=True,
        args=TrainingArguments(
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            warmup_steps=10,
            num_train_epochs=3,
            learning_rate=2e-4,
            fp16=not torch.cuda.is_available(),
            bf16=torch.cuda.is_available(),
            logging_steps=1,
            optim="adamw_8bit",
            weight_decay=0.01,
            lr_scheduler_type="linear",
            seed=3407,
            output_dir=str(OUTPUT_DIR),
            report_to="none",
        ),
    )

    print()
    print("开始训练...")
    print("注意: 第一次运行可能需要下载模型，请耐心等待...")
    print()

    # 开始训练
    trainer.train()

    # 保存模型
    print()
    print("正在保存模型...")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(OUTPUT_DIR / "lora_adapter"))
    tokenizer.save_pretrained(str(OUTPUT_DIR / "lora_adapter"))

    print()
    print("=" * 60)
    print("✅ 微调完成!")
    print(f"📁 LoRA 适配器保存到: {OUTPUT_DIR / 'lora_adapter'}")
    print("=" * 60)
    print()
    print("下一步: 将 LoRA 适配器合并到模型中")
    print("使用命令: python scripts/merge_lora.py")

if __name__ == "__main__":
    main()
