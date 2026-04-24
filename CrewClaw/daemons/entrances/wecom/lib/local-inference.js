'use strict';
/**
 * callLocalMLX — 统一本地推理路由（L5 Phase 1）
 *
 * 职责：按 role 注入对应 LoRA adapter，调用 mlx_lm / mlx_vlm 本地推理。
 * 如果角色 adapter 尚未训练，fallback 到 Ollama（文本→homeai-assistant，视觉→qwen3-vl:32b-q4）。
 *
 * 调用路径：
 *   文本推理  → python3.11 -m mlx_lm.generate  --model <base> --adapter-path <role-adapter> --prompt ...
 *   视觉推理  → python3.11 -m mlx_vlm.generate --model <base> --adapter-path <role-adapter> --image ... --prompt ...
 *   Fallback  → Ollama /v1/chat/completions（homeai-assistant 或 qwen3-vl:32b-q4）
 *
 * 使用示例：
 *   const { callLocalMLX } = require('./local-inference');
 *   const text = await callLocalMLX('lucas', '帮我总结一下今天的任务');
 *   const desc = await callLocalMLX('lucas', '描述这张图', '/tmp/photo.jpg');
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const PYTHON = process.env.LOCAL_PYTHON || '/opt/homebrew/opt/python@3.11/bin/python3.11';
const MLX_BASE_MODEL = process.env.LOCAL_MLX_BASE || `${process.env.HOME}/HomeAI/Models/mlx/Qwen3-VL-32B-4bit`;
const ADAPTERS_ROOT = process.env.LOCAL_ADAPTERS_ROOT || `${process.env.HOME}/HomeAI/Models/adapters`;
const OLLAMA_BASE = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

// role → adapter 目录名映射（训练完成后目录存在即生效）
const ROLE_ADAPTER_MAP = {
  lucas: 'qwen3vl-lucas',
  andy:  'qwen3vl-andy',
  lisa:  'qwen3vl-lisa',
};

// fallback Ollama 模型名
const FALLBACK_TEXT_MODEL   = process.env.LOCAL_MODEL_NAME || 'homeai-assistant';
const FALLBACK_VISION_MODEL = process.env.LOCAL_VISION_MODEL || 'qwen3-vl:32b-q4';

/**
 * 判断 role 的 adapter 是否已训练完成（目录存在且含 adapters.safetensors）
 */
function adapterExists(role) {
  const name = ROLE_ADAPTER_MAP[role];
  if (!name) return false;
  const adapterPath = path.join(ADAPTERS_ROOT, name);
  return fs.existsSync(path.join(adapterPath, 'adapters.safetensors'));
}

/**
 * callLocalMLX(role, prompt, imagePath?)
 *
 * @param {string} role - 'lucas' | 'andy' | 'lisa'
 * @param {string} prompt - 用户提示词
 * @param {string} [imagePath] - 图片文件绝对路径（视觉推理时传入）
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=512] - 最大输出 token 数
 * @param {number} [opts.timeoutMs=120000] - 超时（毫秒）
 * @returns {Promise<string>} - 模型回复文本
 */
async function callLocalMLX(role, prompt, imagePath = null, opts = {}) {
  const { maxTokens = 512, timeoutMs = 120000 } = opts;
  const hasVision = !!imagePath;

  // ── MLX 路径（adapter 已训练）──
  if (adapterExists(role)) {
    const adapterPath = path.join(ADAPTERS_ROOT, ROLE_ADAPTER_MAP[role]);
    const module = hasVision ? 'mlx_vlm.generate' : 'mlx_lm.generate';

    const args = [
      '-m', module,
      '--model', MLX_BASE_MODEL,
      '--adapter-path', adapterPath,
      '--max-tokens', String(maxTokens),
      '--temp', '0.7',
      '--prompt', prompt,
    ];
    if (hasVision && imagePath) {
      args.push('--image', imagePath);
    }

    const result = spawnSync(PYTHON, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env },
    });

    if (result.status === 0 && result.stdout) {
      // mlx_lm.generate 输出格式：最后一行是 "==========\n{response}"
      const lines = result.stdout.trim().split('\n');
      // 跳过 "==========" 分隔线，取其后内容
      const sepIdx = lines.lastIndexOf('==========');
      const response = sepIdx >= 0
        ? lines.slice(sepIdx + 1).join('\n').trim()
        : lines[lines.length - 1].trim();
      if (response) return response;
    }

    // MLX（带 adapter）失败，记录并 fallback
    const errMsg = result.stderr?.slice(0, 200) || 'unknown error';
    console.warn(`[callLocalMLX] MLX adapter (${role}) 失败，fallback: ${errMsg}`);
  }

  // ── 视觉路径 fallback：mlx_vlm base model（无 adapter）──
  // Qwen3-VL-32B-4bit 是 MLX 4-bit 量化模型，无法转 GGUF，只能走 mlx_vlm 直接推理
  if (hasVision && imagePath) {
    const baseModelExists = fs.existsSync(path.join(MLX_BASE_MODEL, 'config.json'));
    if (baseModelExists) {
      const args = [
        '-m', 'mlx_vlm.generate',
        '--model', MLX_BASE_MODEL,
        '--max-tokens', String(maxTokens),
        '--temp', '0.7',
        '--prompt', prompt,
        '--image', imagePath,
      ];
      const result = spawnSync(PYTHON, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        env: { ...process.env },
      });
      if (result.status === 0 && result.stdout) {
        const lines = result.stdout.trim().split('\n');
        const sepIdx = lines.lastIndexOf('==========');
        const response = sepIdx >= 0
          ? lines.slice(sepIdx + 1).join('\n').trim()
          : lines[lines.length - 1].trim();
        if (response) return response;
      }
      console.warn(`[callLocalMLX] mlx_vlm base 失败，降级云端: ${result.stderr?.slice(0, 100)}`);
    }
    // 视觉最后降级：DashScope qwen-vl-plus（在 media.js 的 describeImageWithLlava 层处理）
    return null;
  }

  // ── 文本路径 fallback：Ollama homeai-assistant ──
  const resp = await axios.post(
    `${OLLAMA_BASE}/v1/chat/completions`,
    {
      model: FALLBACK_TEXT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.7,
    },
    { timeout: timeoutMs }
  );

  return resp.data?.choices?.[0]?.message?.content?.trim() || '';
}

/**
 * listLocalModels() — 返回当前本地模型状态快照（供 evaluate_l0 / evaluate_l4 使用）
 */
function listLocalModels() {
  const roles = Object.keys(ROLE_ADAPTER_MAP);
  const adapterStatus = roles.map(role => ({
    role,
    adapterName: ROLE_ADAPTER_MAP[role],
    ready: adapterExists(role),
    path: path.join(ADAPTERS_ROOT, ROLE_ADAPTER_MAP[role]),
  }));

  const baseModelExists = fs.existsSync(path.join(MLX_BASE_MODEL, 'config.json'));

  return {
    baseModel: MLX_BASE_MODEL,
    baseModelExists,
    adapters: adapterStatus,
    fallbackText: FALLBACK_TEXT_MODEL,
    fallbackVision: FALLBACK_VISION_MODEL,
  };
}

module.exports = { callLocalMLX, listLocalModels, adapterExists, ROLE_ADAPTER_MAP };
