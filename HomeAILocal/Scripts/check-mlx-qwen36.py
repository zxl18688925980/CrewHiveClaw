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
import glob
import subprocess
from datetime import datetime

HOMEAI_DATA = os.path.expanduser("~/HomeAI/Data")
HOMEAI_MODELS = os.path.expanduser("~/HomeAI/Models")
PENDING_TASKS_FILE = os.path.join(HOMEAI_DATA, "main-pending-tasks.json")
TASK_ID = "mlx-qwen36-ready"
GGUF_LOCK = os.path.join(HOMEAI_DATA, "gguf-conversion.lock")
GGUF_DONE = os.path.join(HOMEAI_DATA, "gguf-conversion-done")  # sentinel：转换完成后写入，后续跳过检测
CONVERT_SCRIPT = "/opt/homebrew/bin/convert_hf_to_gguf.py"
PYTHON311 = "/opt/homebrew/opt/python@3.11/bin/python3.11"


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


def check_gguf_support() -> bool:
    """检查 gguf 包是否支持 qwen3_5_moe GGUF 转换（以 MISTRAL4 枚举为判断标志）"""
    try:
        import gguf
        return hasattr(gguf.MODEL_ARCH, "MISTRAL4")
    except ImportError:
        return False


def find_pending_gguf() -> tuple:
    """返回 (fused_dir, gguf_path) 若最新 fused 目录对应的 GGUF 尚未生成，否则 (None, None)"""
    adapters_base = os.path.join(HOMEAI_MODELS, "adapters")
    fused_dirs = sorted(glob.glob(os.path.join(adapters_base, "fused-*")))
    if not fused_dirs:
        return None, None
    latest_fused = fused_dirs[-1]
    run_date = os.path.basename(latest_fused).replace("fused-", "")
    gguf_path = os.path.join(adapters_base, f"homeai-assistant-{run_date}.gguf")
    if os.path.exists(gguf_path):
        return None, None  # 已转换过
    return latest_fused, gguf_path


def write_gguf_task(status: str, detail: str):
    """将 GGUF 转换结果写入 main-pending-tasks.json 通知系统工程师"""
    tasks = load_pending_tasks()
    task_id = "gguf-conversion-result"
    tasks = [t for t in tasks if t.get("id") != task_id]  # 去重
    tasks.append({
        "id": task_id,
        "title": f"GGUF 转换{status}：homeai-assistant 更新情况",
        "description": detail,
        "status": "pending",
        "createdAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "check-mlx-qwen36/gguf-auto-convert",
    })
    save_pending_tasks(tasks)


def trigger_gguf_conversion(fused_dir: str, gguf_path: str):
    """异步触发 GGUF 转换 + ollama 更新，使用 lock 防止重复"""
    if os.path.exists(GGUF_LOCK):
        print("[check-gguf] 转换任务已在运行（lock 存在），跳过")
        return

    log_file = os.path.expanduser("~/HomeAI/Logs/gguf-convert.log")
    modelfile_tmp = f"/tmp/homeai-gguf-modelfile-{datetime.now().strftime('%Y%m%d%H%M%S')}"

    # 写 Modelfile（Method A，与 run-finetune.sh 一致）
    modelfile_content = f"""FROM {gguf_path}
PARAMETER temperature 0.6
PARAMETER top_p 0.95
PARAMETER top_k 20
PARAMETER num_ctx 8192
PARAMETER stop "<|im_end|>"
PARAMETER stop "<|endoftext|>"
"""

    shell_script = f"""#!/bin/bash
set -e
touch {GGUF_LOCK}
LOG={log_file}
echo "[$(date '+%Y-%m-%d %H:%M:%S')] gguf 包已支持 MISTRAL4，开始 GGUF 转换..." >> "$LOG"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] fused: {fused_dir}" >> "$LOG"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] gguf: {gguf_path}" >> "$LOG"

{PYTHON311} {CONVERT_SCRIPT} \\
  {fused_dir} \\
  --outfile {gguf_path} \\
  --outtype q4_0 \\
  >> "$LOG" 2>&1

if [ -f "{gguf_path}" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ GGUF 生成成功，更新 Ollama homeai-assistant..." >> "$LOG"
  cat > {modelfile_tmp} << 'MODELEOF'
{modelfile_content}MODELEOF
  ollama create homeai-assistant -f {modelfile_tmp} >> "$LOG" 2>&1
  rm -f {modelfile_tmp}
  {PYTHON311} {os.path.abspath(__file__)} --notify-gguf-done "{gguf_path}" >> "$LOG" 2>&1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ homeai-assistant 已更新为微调版本" >> "$LOG"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ GGUF 文件未生成，转换失败" >> "$LOG"
  {PYTHON311} {os.path.abspath(__file__)} --notify-gguf-failed "{fused_dir}" >> "$LOG" 2>&1
fi
rm -f {GGUF_LOCK}
"""
    script_path = f"/tmp/homeai-gguf-convert-{datetime.now().strftime('%Y%m%d%H%M%S')}.sh"
    with open(script_path, "w") as f:
        f.write(shell_script)
    os.chmod(script_path, 0o755)

    subprocess.Popen(
        ["nohup", "bash", script_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    print(f"[check-gguf] 已触发 GGUF 转换任务（后台），日志: {log_file}")


if __name__ == "__main__":
    # --notify-gguf-done / --notify-gguf-failed 由转换脚本回调
    if len(sys.argv) >= 2 and sys.argv[1] == "--notify-gguf-done":
        gguf_path = sys.argv[2] if len(sys.argv) > 2 else "unknown"
        write_gguf_task("成功", f"GGUF 已生成并上线：{gguf_path}\nhomeai-assistant 已更新为微调后版本（Qwen3.6 LoRA）。")
        # 写 sentinel：后续 HEARTBEAT 跳过 GGUF 检测，任务完成消除
        with open(GGUF_DONE, "w") as f:
            f.write(f"{datetime.now().strftime('%Y-%m-%dT%H:%M:%S')} {gguf_path}\n")
        sys.exit(0)
    if len(sys.argv) >= 2 and sys.argv[1] == "--notify-gguf-failed":
        fused_dir = sys.argv[2] if len(sys.argv) > 2 else "unknown"
        write_gguf_task("失败", f"GGUF 转换失败，fused 目录：{fused_dir}\n详情查看 ~/HomeAI/Logs/gguf-convert.log")
        sys.exit(1)

    # 主流程
    supported, info = check_support()
    if supported:
        print(f"[check-mlx-qwen36] ✅ 支持 (mlx-lm {info})")
        ensure_task_written(info)
    else:
        print(f"[check-mlx-qwen36] ⏳ 尚不支持: {info}")

    # GGUF 转换检测（独立于 MLX 支持检测，每次 HEARTBEAT 都跑）
    # sentinel 存在 = 已完成，消除该任务，不再检测
    if os.path.exists(GGUF_DONE):
        print("[check-gguf] ✅ GGUF 转换已完成（sentinel 存在），跳过检测")
    elif check_gguf_support():
        fused_dir, gguf_path = find_pending_gguf()
        if fused_dir:
            print(f"[check-gguf] ✅ gguf 包已支持 MISTRAL4，触发自动转换: {fused_dir}")
            trigger_gguf_conversion(fused_dir, gguf_path)
        else:
            print("[check-gguf] ✅ gguf 支持，无待转换 fused 模型")
    else:
        print("[check-gguf] ⏳ gguf 包尚不支持 MISTRAL4，等待包更新"
              "（pip install --upgrade gguf 后自动触发）")

    sys.exit(0 if supported else 1)
