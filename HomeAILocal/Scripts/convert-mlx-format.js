#!/usr/bin/env node

/**
 * 将训练数据转换为 MLX 格式
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = '/Users/xinbinanshan/HomeAI/training_data';

// MLX 格式转换
function convertToMLXFormat(inputFile, outputFile) {
  const content = fs.readFileSync(inputFile, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const mlxData = lines.map(line => {
    const item = JSON.parse(line);
    return {
      messages: [
        { role: 'user', content: item.instruction + (item.input ? '\n\n' + item.input : '') },
        { role: 'assistant', content: item.output }
      ]
    };
  });

  fs.writeFileSync(outputFile, mlxData.map(d => JSON.stringify(d)).join('\n'));
  return mlxData.length;
}

// 转换每个角色的数据
const roles = ['main', 'lucas', 'andy', 'lisa'];

for (const role of roles) {
  const inputPath = path.join(OUTPUT_DIR, role, 'train.jsonl');
  const outputPath = path.join(OUTPUT_DIR, role, 'train_mlx.jsonl');

  if (fs.existsSync(inputPath)) {
    const count = convertToMLXFormat(inputPath, outputPath);
    console.log(`${role}: ${count} 条数据已转换为 MLX 格式`);
  }
}

// 处理 Lisa 的代码数据
const lisaCodePath = path.join(OUTPUT_DIR, 'lisa', 'code.jsonl');
const lisaMLXPath = path.join(OUTPUT_DIR, 'lisa', 'code_mlx.jsonl');

if (fs.existsSync(lisaCodePath)) {
  const content = fs.readFileSync(lisaCodePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const mlxData = lines.map(line => {
    const item = JSON.parse(line);
    return {
      messages: [
        { role: 'user', content: item.instruction },
        { role: 'assistant', content: item.output }
      ]
    };
  });

  fs.writeFileSync(lisaMLXPath, mlxData.map(d => JSON.stringify(d)).join('\n'));
  console.log(`lisa (code): ${mlxData.length} 条数据已转换为 MLX 格式`);
}

console.log('\n数据转换完成！');
