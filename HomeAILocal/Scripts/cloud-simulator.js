#!/usr/bin/env node
/**
 * HomeAI 云端系统模拟器
 * 模拟云端三位大师的语料接收、聚合、微调、蒸馏、Readme 进化全流程
 *
 * 端口: 4000
 * 用法: node scripts/cloud-simulator.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const fs      = require('fs').promises;
const path    = require('path');
const axios   = require('axios');

const app  = express();
const PORT = process.env.CLOUD_SIM_PORT || 4000;

const SIM_DIR = path.join(__dirname, '../data/cloud-sim');

app.use(express.json({ limit: '10mb' }));

// ── 工具函数 ────────────────────────────────────────────────

async function readJsonLines(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

async function appendJsonLine(filePath, obj) {
  await fs.appendFile(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

async function readState() {
  const statePath = path.join(SIM_DIR, 'state.json');
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch (e) {
    return {
      families: {},
      finetune_rounds: 0,
      last_finetune: null,
      readme_version: 0,
      total_corpus_lines: { lucas: 0, andy: 0, lisa: 0 }
    };
  }
}

async function saveState(state) {
  await fs.writeFile(
    path.join(SIM_DIR, 'state.json'),
    JSON.stringify(state, null, 2), 'utf8'
  );
}

// ── 语料接收端点（三位大师）─────────────────────────────────

async function receiveCorpus(role, req, res) {
  const { date, lines: lineCount, data, family_id = 'family_001' } = req.body;

  if (!data) return res.status(400).json({ error: '缺少 data 字段' });

  const received = {
    family_id,
    role,
    date: date || new Date().toISOString().substring(0, 10),
    received_at: new Date().toISOString(),
    line_count: lineCount || data.split('\n').filter(Boolean).length,
    preview: data.split('\n')[0]?.substring(0, 100) || ''
  };

  // 保存原始语料
  const corpusFile = path.join(SIM_DIR, `corpus/${role}/${family_id}-${received.date}.jsonl`);
  await fs.writeFile(corpusFile, data, 'utf8');

  // 更新接收日志
  await appendJsonLine(path.join(SIM_DIR, `corpus/${role}/receive-log.jsonl`), received);

  // 更新状态
  const state = await readState();
  if (!state.families[family_id]) {
    state.families[family_id] = { first_seen: new Date().toISOString(), uploads: 0 };
  }
  state.families[family_id].uploads++;
  state.families[family_id].last_upload = new Date().toISOString();
  state.total_corpus_lines[role] = (state.total_corpus_lines[role] || 0) + received.line_count;
  await saveState(state);

  console.log(`[cloud] 收到 ${family_id} 的 ${role} 语料 ${received.line_count} 行`);

  res.json({
    success: true,
    received: received.line_count,
    family_id,
    message: `${role} 语料已入库，感谢 ${family_id} 的贡献`
  });
}

app.post('/corpus/lucas', (req, res) => receiveCorpus('lucas', req, res));
app.post('/corpus/andy',  (req, res) => receiveCorpus('andy',  req, res));
app.post('/corpus/lisa',  (req, res) => receiveCorpus('lisa',  req, res));

// ── 状态概览 ────────────────────────────────────────────────

app.get('/status', async (req, res) => {
  const state = await readState();

  const corpusStats = {};
  for (const role of ['lucas', 'andy', 'lisa']) {
    const log = await readJsonLines(path.join(SIM_DIR, `corpus/${role}/receive-log.jsonl`));
    corpusStats[role] = {
      total_lines: state.total_corpus_lines[role] || 0,
      families: [...new Set(log.map(l => l.family_id))].length,
      last_upload: log[log.length - 1]?.received_at || null
    };
  }

  res.json({
    status: 'running',
    port: PORT,
    families: Object.keys(state.families).length,
    family_list: Object.keys(state.families),
    corpus: corpusStats,
    finetune_rounds: state.finetune_rounds,
    last_finetune: state.last_finetune,
    readme_version: state.readme_version
  });
});

// ── 模拟微调 ────────────────────────────────────────────────

app.post('/simulate/finetune', async (req, res) => {
  const state = await readState();
  const totalLines = Object.values(state.total_corpus_lines).reduce((a, b) => a + b, 0);
  const familyCount = Object.keys(state.families).length;

  if (totalLines === 0) {
    return res.json({ success: false, message: '尚无语料，请先上传语料' });
  }

  // 模拟微调过程
  const round = state.finetune_rounds + 1;
  const steps = [
    { step: 1, name: '语料清洗与格式化',   duration_ms: 800  },
    { step: 2, name: 'LoRA 适配器训练',   duration_ms: 1200 },
    { step: 3, name: '多家庭语料聚合',     duration_ms: 600  },
    { step: 4, name: '蒸馏到本地模型格式', duration_ms: 700  },
    { step: 5, name: '质量验证',          duration_ms: 500  }
  ];

  const results = [];
  for (const s of steps) {
    await new Promise(r => setTimeout(r, s.duration_ms));
    results.push({ ...s, status: 'done' });
  }

  // 模拟质量提升（多家庭语料 > 单家庭）
  const baseQuality    = 0.60;
  const singleFamilyQ  = baseQuality + (round * 0.03);
  const multiFamilyQ   = familyCount > 1
    ? singleFamilyQ + (familyCount - 1) * 0.05
    : singleFamilyQ;

  const finetuneRecord = {
    round,
    timestamp: new Date().toISOString(),
    families_contributed: familyCount,
    total_corpus_lines: totalLines,
    corpus_breakdown: state.total_corpus_lines,
    steps: results,
    quality: {
      single_family_baseline: parseFloat(singleFamilyQ.toFixed(3)),
      multi_family_result: parseFloat(multiFamilyQ.toFixed(3)),
      improvement: familyCount > 1
        ? `+${((multiFamilyQ - singleFamilyQ) * 100).toFixed(1)}%（群体进化效应）`
        : '单家庭基准'
    }
  };

  state.finetune_rounds = round;
  state.last_finetune   = new Date().toISOString();
  await saveState(state);

  await appendJsonLine(
    path.join(SIM_DIR, 'finetune/history.jsonl'),
    finetuneRecord
  );

  console.log(`[cloud] 第 ${round} 轮微调完成，质量 ${multiFamilyQ.toFixed(3)}`);
  res.json({ success: true, ...finetuneRecord });
});

// ── 模拟蒸馏（生成本地模型更新包）───────────────────────────

app.post('/simulate/distill', async (req, res) => {
  const state = await readState();

  if (state.finetune_rounds === 0) {
    return res.json({ success: false, message: '请先执行微调再蒸馏' });
  }

  await new Promise(r => setTimeout(r, 1000));

  const distillResult = {
    timestamp: new Date().toISOString(),
    source_rounds: state.finetune_rounds,
    roles_distilled: ['lucas', 'andy', 'lisa'],
    output: {
      model_name: 'homeai-assistant-distilled',
      version: `v${state.finetune_rounds}.0`,
      size_mb: 4200 + state.finetune_rounds * 12,
      capabilities: [
        '更懂家庭业务对话（来自多家庭 lucas 语料）',
        '更准确的架构设计决策（来自多家庭 andy 语料）',
        '更高质量的代码生成（来自多家庭 lisa 语料）'
      ]
    },
    download_url: `http://localhost:${PORT}/models/homeai-assistant-distilled-v${state.finetune_rounds}.0.gguf`
  };

  console.log(`[cloud] 蒸馏完成，输出 ${distillResult.output.model_name} ${distillResult.output.version}`);
  res.json({ success: true, ...distillResult });
});

// ── 模拟 Readme 进化 ─────────────────────────────────────────

app.post('/simulate/readme', async (req, res) => {
  const state = await readState();

  if (state.total_corpus_lines.lucas === 0) {
    return res.json({ success: false, message: '语料不足，无法生成 Readme' });
  }

  // 调用 GLM 生成 Readme 片段
  let generatedSection = '';
  try {
    const log = await readJsonLines(
      path.join(SIM_DIR, 'corpus/lucas/receive-log.jsonl')
    );
    const families = [...new Set(log.map(l => l.family_id))];
    const prompt = `基于 ${families.length} 个家庭的使用语料（共 ${state.total_corpus_lines.lucas} 条对话），
提炼 HomeAI 系统的最佳实践 Setup 建议（3条，每条1-2句话，简洁实用）。`;

    const resp = await axios.post(
      process.env.LISA_CLOUD_URL,
      { model: process.env.LISA_CLOUD_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 300 },
      { headers: { Authorization: `Bearer ${process.env.LISA_CLOUD_API_KEY}` }, timeout: 20000 }
    );
    generatedSection = resp.data.choices?.[0]?.message?.content || '';
  } catch (e) {
    generatedSection = `[模拟生成] 基于 ${Object.keys(state.families).length} 个家庭的经验：\n` +
      '1. 企业微信配置建议优先使用 bore 穿透，稳定性最佳\n' +
      '2. Ollama 拉取模型前确保磁盘剩余 >= 15GB\n' +
      '3. ChromaDB 首次启动后等待 10 秒再连接';
  }

  const version = state.readme_version + 1;
  const readmeUpdate = {
    version,
    timestamp: new Date().toISOString(),
    contributed_families: Object.keys(state.families).length,
    generated_section: generatedSection,
    section_title: '## 来自社区的最佳实践'
  };

  state.readme_version = version;
  await saveState(state);

  await fs.writeFile(
    path.join(SIM_DIR, `readme/readme-v${version}.md`),
    `# HomeAI Readme 进化版本 ${version}\n\n` +
    `> 基于 ${readmeUpdate.contributed_families} 个家庭的语料提炼\n\n` +
    readmeUpdate.generated_section + '\n',
    'utf8'
  );

  console.log(`[cloud] Readme v${version} 生成完成`);
  res.json({ success: true, ...readmeUpdate });
});

// ── 群体进化效应报告 ────────────────────────────────────────

app.get('/simulate/evolution-report', async (req, res) => {
  const state   = await readState();
  const history = await readJsonLines(path.join(SIM_DIR, 'finetune/history.jsonl'));

  if (history.length === 0) {
    return res.json({ message: '尚无微调记录，请先执行 /simulate/finetune' });
  }

  const report = {
    title: '群体进化效应报告',
    generated_at: new Date().toISOString(),
    summary: {
      families: Object.keys(state.families).length,
      finetune_rounds: state.finetune_rounds,
      readme_versions: state.readme_version,
      total_corpus: state.total_corpus_lines
    },
    quality_trend: history.map(h => ({
      round: h.round,
      families: h.families_contributed,
      quality: h.quality
    })),
    conclusion: Object.keys(state.families).length > 1
      ? `✅ 群体进化效应已验证：${Object.keys(state.families).length} 个家庭协作训练质量优于单家庭`
      : '⏳ 需要第二个家庭加入才能验证群体进化效应',
    next_action: state.readme_version === 0
      ? '执行 POST /simulate/readme 生成进化版 Readme'
      : `Readme 已进化到 v${state.readme_version}，可分发给新家庭使用`
  };

  res.json(report);
});

// ── 启动 ────────────────────────────────────────────────────

app.listen(PORT, async () => {
  const state = await readState();
  console.log('\n' + '='.repeat(55));
  console.log('   HomeAI 云端系统模拟器');
  console.log('='.repeat(55));
  console.log(`   地址:    http://localhost:${PORT}`);
  console.log(`   家庭数:  ${Object.keys(state.families).length}`);
  console.log(`   微调轮次: ${state.finetune_rounds}`);
  console.log('='.repeat(55));
  console.log('\n端点列表:');
  console.log('  POST /corpus/lucas           接收 Lucas 语料');
  console.log('  POST /corpus/andy            接收 Andy 语料');
  console.log('  POST /corpus/lisa            接收 Lisa 语料');
  console.log('  GET  /status                 云端状态概览');
  console.log('  POST /simulate/finetune      模拟微调');
  console.log('  POST /simulate/distill       模拟蒸馏');
  console.log('  POST /simulate/readme        模拟 Readme 进化');
  console.log('  GET  /simulate/evolution-report  群体进化效应报告');
  console.log('\n  q / Ctrl+C 退出\n');
});

process.on('SIGINT', () => { console.log('\n[cloud] 模拟器已停止'); process.exit(0); });
