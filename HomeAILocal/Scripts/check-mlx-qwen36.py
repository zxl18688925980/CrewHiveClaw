#!/usr/bin/env python3
"""
check-mlx-qwen36.py — 检测 MLX-LM 是否支持 Qwen3.6 MoE (qwen3_5_moe) LoRA 训练
由 Andy HEARTBEAT 检查 0 调用（每次 HEARTBEAT 必执行，最优先）

退出码：
  0 = 支持，已就绪
  1 = 尚不支持
  2 = 检测出错

检测到支持时写入 ~/HomeAI/Data/main-pending-tasks.json 通知系统工程师
"""

import sys
import json
import os
from datetime import datetime

HOMEAI_DATA = os.path.expanduser("~/HomeAI/Data")
PENDING_TASKS_FILE = os.path.join(HOMEAI_DATA, "main-pending-tasks.json")
TASK_ID = "mlx-qwen36-ready"


def check_support() -> tuple[bool, str]:
    """返回 (支持, 版本/原因)"""
    try:
        import mlx_lm
        version = getattr(mlx_lm, "__version__", "unknown")

        # 条件1：qwen3_5_moe 架构模块可导入
        from mlx_lm.models.qwen3_5_moe import Model, ModelArgs  # noqa
        # 条件2：LoRA 训练模块可用
        from mlx_lm.tuner.lora import LoRALinear  # noqa
        from mlx_lm.tuner.trainer import TrainingArgs  # noqa

        return True, version
    except ImportError as e:
        return False, str(e)
    except Exception as e:
        return False, f"error: {e}"


def load_pending_tasks() -> list:
    try:
        if os.path.exists(PENDING_TASKS_FILE):
            with open(PENDING_TASKS_FILE, "r") as f:
                data = json.load(f)
                return data if isinstance(data, list) else []
    except Exception:
        pass
    return []


def save_pending_tasks(tasks: list):
    os.makedirs(HOMEAI_DATA, exist_ok=True)
    with open(PENDING_TASKS_FILE, "w") as f:
        json.dump(tasks, f, ensure_ascii=False, indent=2)


def ensure_task_written(version: str):
    tasks = load_pending_tasks()
    # 已存在且 pending/done 则不重复写
    existing = next((t for t in tasks if t.get("id") == TASK_ID), None)
    if existing:
        return  # 已记录，无需重复

    tasks.append({
        "id": TASK_ID,
        "title": f"MLX-LM {version} 已支持 Qwen3.6 MoE LoRA 微调，可启动 T7/T8",
        "description": (
            "mlx-lm 已支持 qwen3_5_moe 架构（LoRALinear + TrainingArgs 全部就绪）。\n"
            "下一步：\n"
            "1. 执行 T7：更新 run-finetune.sh 基础模型为 Qwen3.6-35B-A3B\n"
            "2. 执行 T8：用 104 条 DPO 样本跑首次微调验证"
        ),
        "status": "pending",
        "createdAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "check-mlx-qwen36",
        "mlxVersion": version,
    })
    save_pending_tasks(tasks)
    print(f"[check-mlx-qwen36] 已写入 main-pending-tasks.json (mlx-lm {version})")


if __name__ == "__main__":
    supported, info = check_support()
    if supported:
        print(f"[check-mlx-qwen36] ✅ 支持 (mlx-lm {info})")
        ensure_task_written(info)
        sys.exit(0)
    else:
        print(f"[check-mlx-qwen36] ⏳ 尚不支持: {info}")
        sys.exit(1)
