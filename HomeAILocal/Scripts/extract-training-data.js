#!/usr/bin/env node

/**
 * 训练数据自动提取脚本
 * 从项目文档和代码中提取微调数据
 */

const fs = require('fs');
const path = require('path');

const DOCS_DIR = '/Users/xinbinanshan/HomeAI/docs';
const CODE_DIR = '/Users/xinbinanshan/HomeAI/homeai';
const OUTPUT_DIR = '/Users/xinbinanshan/HomeAI/training_data';

// 角色配置
const ROLES = {
  main: {
    name: '系统工程师',
    keywords: ['MCP', '插件', '系统', '管理', '维护', '配置', '安装', '卸载'],
    files: ['03-configuration-management.md', '05-environment-setup.md']
  },
  lucas: {
    name: '业务架构师',
    keywords: ['对话', '意图', '任务', '编排', 'Skill', '能力', '家人', '需求'],
    files: ['00-project-overview.md', 'HomeAI Readme.md']
  },
  andy: {
    name: '系统架构师',
    keywords: ['架构', '设计', '技术', '决策', '文档', '需求'],
    files: ['00-project-overview.md', '02-requirements-decomposition.md']
  },
  lisa: {
    name: '编码专家',
    keywords: ['代码', '实现', '调试', '测试', '修复', '开发'],
    files: ['06-basic-version.md', '07-advanced-version.md']
  }
};

// 提取问答对
function extractQAPairs(text, role) {
  const pairs = [];
  const lines = text.split('\n');

  let currentSection = '';
  let currentContent = [];

  for (const line of lines) {
    // 检测章节标题
    if (line.match(/^#{1,3}\s/)) {
      // 保存之前的段落
      if (currentContent.length > 2) {
        const content = currentContent.join(' ').trim();
        if (content.length > 50) {
          pairs.push({
            instruction: `作为${role.name}，请解释：${currentSection}`,
            input: '',
            output: content
          });
        }
      }
      currentSection = line.replace(/^#{1,3}\s+/, '').trim();
      currentContent = [];
    } else if (line.trim() && !line.startsWith('|') && !line.startsWith('```')) {
      currentContent.push(line.trim());
    }
  }

  return pairs;
}

// 从文档提取数据
function extractFromDocs() {
  const allData = {};

  for (const [roleId, role] of Object.entries(ROLES)) {
    const pairs = [];

    for (const docFile of role.files) {
      const docPath = path.join(DOCS_DIR, docFile);
      if (fs.existsSync(docPath)) {
        const content = fs.readFileSync(docPath, 'utf-8');
        const rolePairs = extractQAPairs(content, role);
        pairs.push(...rolePairs);
      }
    }

    // 添加角色设定
    const workspacePath = path.join('/Users/xinbinanshan/HomeAI/agents', roleId, 'workspace');
    if (fs.existsSync(workspacePath)) {
      const identityPath = path.join(workspacePath, 'IDENTITY.md');
      const soulPath = path.join(workspacePath, 'SOUL.md');

      if (fs.existsSync(identityPath)) {
        const identity = fs.readFileSync(identityPath, 'utf-8');
        pairs.push({
          instruction: `作为${role.name}，介绍你的身份`,
          input: '',
          output: identity
        });
      }

      if (fs.existsSync(soulPath)) {
        const soul = fs.readFileSync(soulPath, 'utf-8');
        pairs.push({
          instruction: `作为${role.name}，说明你的核心价值观和行为准则`,
          input: '',
          output: soul
        });
      }
    }

    allData[roleId] = pairs;
  }

  return allData;
}

// 从代码提取数据
function extractFromCode() {
  const pairs = [];

  function walkDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory() && !file.startsWith('.') && file !== 'node_modules') {
        walkDir(fullPath);
      } else if (file.endsWith('.js')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        // 提取函数和类的注释作为训练数据
        const matches = content.match(/\/\*\*[\s\S]*?\*\/\s*(?:async\s+)?function\s+(\w+)/g);
        if (matches) {
          for (const match of matches) {
            const funcName = match.match(/function\s+(\w+)/)?.[1];
            if (funcName) {
              pairs.push({
                instruction: '解释这个函数的作用',
                input: match,
                output: `这是一个名为 ${funcName} 的函数，详情请参考代码实现。`
              });
            }
          }
        }
      }
    }
  }

  walkDir(CODE_DIR);
  return pairs;
}

// 主函数
function main() {
  console.log('开始提取训练数据...');

  // 提取文档数据
  const docData = extractFromDocs();

  // 提取代码数据
  const codeData = extractFromCode();

  // 保存数据
  for (const [roleId, pairs] of Object.entries(docData)) {
    const outputPath = path.join(OUTPUT_DIR, roleId, 'train.jsonl');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const jsonl = pairs.map(p => JSON.stringify(p)).join('\n');
    fs.writeFileSync(outputPath, jsonl);

    console.log(`${ROLES[roleId].name}: ${pairs.length} 条数据`);
  }

  // 保存代码数据到 lisa
  const lisaCodePath = path.join(OUTPUT_DIR, 'lisa', 'code.jsonl');
  fs.writeFileSync(lisaCodePath, codeData.map(p => JSON.stringify(p)).join('\n'));

  console.log(`\n代码数据: ${codeData.length} 条`);
  console.log(`总数据: ${Object.values(docData).reduce((a, b) => a + b.length, 0) + codeData.length} 条`);
  console.log(`\n数据已保存到: ${OUTPUT_DIR}`);
}

main();
