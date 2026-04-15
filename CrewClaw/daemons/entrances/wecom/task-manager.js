/**
 * TaskManager — Lucas 长流程任务队列
 *
 * 解决的核心问题：
 *   1. response_url TTL 竞争：立即 ACK，处理异步化，结果通过主动推送送达
 *   2. 同用户并发干扰：per-user Promise 链 mutex，同用户任务严格串行
 *   3. 失败不记录：任务创建即写磁盘，失败写 dead-letter，Lucas 可检索
 *   4. Whisper 推送无保障：Notifier 带 3 次重试（5s/15s/60s 退避）
 *
 * 使用方式（在 startBotLongConnection 建连后）：
 *   taskManager.setWsClient(wsClient);
 *   await taskManager.enqueue({ type, userId, chatId, isGroup, input, histKey, memberName, memberTag });
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const axios  = require('axios');

// ─── 任务状态常量 ────────────────────────────────────────────────────────────
const STATUS = {
  PENDING:    'pending',
  PROCESSING: 'processing',
  COMPLETED:  'completed',
  NOTIFIED:   'notified',
  FAILED:     'failed',
};

// 重试参数
const MAX_RETRIES   = 2;
const RETRY_DELAYS  = [5000, 15000, 60000]; // ms

// 视频文件大小上限
const VIDEO_SIZE_LIMIT = 50 * 1024 * 1024;  // 50MB

// 并发限制
const CONCURRENCY = {
  video_transcription: 2,
  image_analysis: 3,
  file_processing: 3,
  default: 2,
};

class TaskManager {
  /**
   * @param {Object} ctx
   * @param {string}   ctx.homeaiRoot
   * @param {Object}   ctx.logger
   * @param {Function} ctx.callGatewayAgent(agentId, message, userId, timeoutMs)
   * @param {Function} ctx.appendChatHistory(key, userText, assistantText)
   * @param {Function} ctx.transcribeLocalVideo(videoPath)
   * @param {Function} ctx.describeImageWithLlava(imagePath)
   * @param {Function} ctx.getFamilyMembers()
   * @param {Function} ctx.getBotClient()   → globalBotClient（主动推送用）
   */
  constructor(ctx) {
    this.ctx        = ctx;
    this._wsClient  = null;
    this._userQueues = {};   // userId → { running: number, queue: Array<{task, resolve, reject}> }

    this._taskDir = path.join(ctx.homeaiRoot, 'data', 'tasks');
    fs.mkdirSync(this._taskDir, { recursive: true });
  }

  /** 建连后注入 wsClient（用于文件下载） */
  setWsClient(wsClient) {
    this._wsClient = wsClient;
  }

  /** 查询某用户某类型任务的 pending + running 数量（用于聚合器判断是否还有进行中的任务） */
  getPendingCount(userId, taskType) {
    const uq = this._userQueues[userId];
    if (!uq) return 0;
    const pending = uq.queue.filter(t => t.type === taskType && t.status === STATUS.PENDING).length;
    return pending + uq.running;
  }

  /**
   * 创建任务并加入该用户的并发受限队列。
   * 调用方不需要 await，fire-and-forget 即可。
   */
  enqueue(data) {
    const task = this._createTask(data);
    const { userId } = task;

    if (!this._userQueues[userId]) {
      this._userQueues[userId] = { running: 0, queue: [] };
    }

    const limit = CONCURRENCY[task.type] || CONCURRENCY.default;
    const q = this._userQueues[userId];

    if (q.running < limit) {
      q.running++;
      this._run(task).finally(() => this._onTaskDone(userId, task.type));
    } else {
      q.queue.push(task);
    }
  }

  _onTaskDone(userId, taskType) {
    const q = this._userQueues[userId];
    if (!q) return;
    q.running--;
    const limit = CONCURRENCY[taskType] || CONCURRENCY.default;
    if (q.queue.length > 0 && q.running < limit) {
      const next = q.queue.shift();
      q.running++;
      this._run(next).finally(() => this._onTaskDone(userId, next.type));
    }
  }

  // ─── 内部：任务生命周期 ───────────────────────────────────────────────────

  _createTask(data) {
    const taskId = `task_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const task = {
      taskId,
      status:     STATUS.PENDING,
      retryCount: 0,
      createdAt:  new Date().toISOString(),
      updatedAt:  new Date().toISOString(),
      result:     null,
      error:      null,
      ...data,
    };
    this._save(task);
    this.ctx.logger.info('TaskManager 任务创建', { taskId, type: task.type, userId: task.userId });
    return task;
  }

  async _run(task) {
    this._update(task, { status: STATUS.PROCESSING, startedAt: new Date().toISOString() });
    try {
      const result = await this._execute(task);
      this._update(task, { status: STATUS.COMPLETED, result, completedAt: new Date().toISOString() });

      // 识别完成后立即把结果写入 chatHistory，供后续文字消息使用
      // 不等 _notify（Lucas 要花 10s+ 生成回复），确保爸爸紧跟着发文字时 Lucas 能看到图片内容
      if (task.type === 'image_analysis' && task.histKey && result.imageDesc) {
        this.ctx.appendChatHistory(
          task.histKey,
          `[系统] 图片《${result.filename}》识别完成`,
          `【图片内容（AI识别）】\n${result.imageDesc}`,
        );
      } else if (task.type === 'video_transcription' && task.histKey && result.transcript) {
        this.ctx.appendChatHistory(
          task.histKey,
          `[系统] 视频《${result.filename}》转录完成`,
          `【视频转录内容】\n${result.transcript.slice(0, 1000)}`,
        );
      }

      await this._notify(task, result);
    } catch (e) {
      this.ctx.logger.warn('TaskManager 任务执行失败', {
        taskId: task.taskId, retryCount: task.retryCount, error: e?.message || String(e),
      });
      if (task.retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAYS[task.retryCount] || 60000;
        this._update(task, { status: STATUS.PENDING, retryCount: task.retryCount + 1 });
        await new Promise(r => setTimeout(r, delay));
        await this._run(task);
      } else {
        this._update(task, { status: STATUS.FAILED, error: e?.message || String(e) });
        await this._deadLetter(task);
      }
    }
  }

  async _execute(task) {
    switch (task.type) {
      case 'video_transcription': return this._execVideo(task);
      case 'image_analysis':      return this._execImage(task);
      case 'file_processing':     return this._execFile(task);
      default:
        throw new Error(`未知任务类型: ${task.type}`);
    }
  }

  // ─── Worker：视频转录 ────────────────────────────────────────────────────

  async _execVideo(task) {
    const { url, aeskey, filename: inputFilename } = task.input;

    // 大小预检
    try {
      const headResp = await axios.head(url, { timeout: 8000 });
      const size = parseInt(headResp.headers['content-length'] || '0', 10);
      if (size > VIDEO_SIZE_LIMIT) {
        throw new Error(`视频超过 ${VIDEO_SIZE_LIMIT / 1024 / 1024}MB 限制（实际 ${(size/1024/1024).toFixed(1)}MB）`);
      }
    } catch (e) {
      if (e.message.includes('限制')) throw e;
      // HEAD 失败继续尝试下载
    }

    if (!this._wsClient) throw new Error('wsClient 未初始化，无法下载媒体文件');

    const { buffer, filename: rawFilename } = await this._wsClient.downloadFile(url, aeskey);

    const filename   = rawFilename || inputFilename || `video_${Date.now()}.mp4`;
    const dateStr    = new Date().toISOString().slice(0, 10);
    const uploadDir  = path.join(this.ctx.homeaiRoot, 'data', 'uploads', dateStr, 'videos');
    fs.mkdirSync(uploadDir, { recursive: true });
    const savePath    = path.join(uploadDir, `${Date.now()}-${filename}`);
    const relativePath = path.relative(this.ctx.homeaiRoot, savePath);
    fs.writeFileSync(savePath, buffer);
    this.ctx.logger.info('TaskManager 视频落盘', { taskId: task.taskId, savePath, bytes: buffer.length });

    const transcript = await this.ctx.transcribeLocalVideo(savePath);
    if (transcript) {
      try { fs.writeFileSync(savePath + '.transcript.txt', transcript, 'utf8'); } catch {}
      this.ctx.logger.info('TaskManager Whisper 转录完成', { taskId: task.taskId, len: transcript.length });
    } else {
      this.ctx.logger.warn('TaskManager Whisper 转录失败或无语音', { taskId: task.taskId });
    }

    return { filename, savePath, relativePath, transcript };
  }

  // ─── Worker：图片分析 ────────────────────────────────────────────────────

  async _execImage(task) {
    const { url, aeskey, filename: inputFilename } = task.input;

    if (!this._wsClient) throw new Error('wsClient 未初始化，无法下载媒体文件');

    const { buffer, filename: rawFilename } = await this._wsClient.downloadFile(url, aeskey);

    const filename   = rawFilename || inputFilename || `image_${Date.now()}.jpg`;
    const dateStr    = new Date().toISOString().slice(0, 10);
    const uploadDir  = path.join(this.ctx.homeaiRoot, 'data', 'uploads', dateStr, 'images');
    fs.mkdirSync(uploadDir, { recursive: true });
    const savePath    = path.join(uploadDir, `${Date.now()}-${filename}`);
    const relativePath = path.relative(this.ctx.homeaiRoot, savePath);
    fs.writeFileSync(savePath, buffer);

    const imageDesc = await this.ctx.describeImageWithLlava(savePath);
    if (imageDesc) {
      try { fs.writeFileSync(savePath + '.desc.txt', imageDesc, 'utf8'); } catch {}
    }

    return { filename, savePath, relativePath, imageDesc };
  }

  // ─── Worker：文件处理 ────────────────────────────────────────────────────

  async _execFile(task) {
    const { url, aeskey, filename: inputFilename } = task.input;

    if (!this._wsClient) throw new Error('wsClient 未初始化，无法下载媒体文件');

    const { buffer, filename: rawFilename } = await this._wsClient.downloadFile(url, aeskey);

    const filename   = rawFilename || inputFilename || `file_${Date.now()}`;
    const dateStr    = new Date().toISOString().slice(0, 10);
    const uploadDir  = path.join(this.ctx.homeaiRoot, 'data', 'uploads', dateStr, 'documents');
    fs.mkdirSync(uploadDir, { recursive: true });
    const savePath    = path.join(uploadDir, `${Date.now()}-${filename}`);
    const relativePath = path.relative(this.ctx.homeaiRoot, savePath);
    fs.writeFileSync(savePath, buffer);

    return { filename, savePath, relativePath };
  }

  // ─── Notifier：结果推送（带重试）────────────────────────────────────────

  async _notify(task, result) {
    const { userId, chatId, isGroup, histKey, memberTag, type } = task;

    // 构建推送给 Lucas 的 follow-up prompt（独立 session，不污染主对话）
    // sessionId 用 streamId 确保每个视频/图片的推送互相独立，避免 histKey 冲突导致覆盖。
    const sessionId = task.streamId || task.userId || 'lucas';
    let followUpPrompt;

    if (type === 'video_transcription') {
      if (result.transcript) {
        followUpPrompt = `${memberTag}[系统：刚才收到的视频已转录完成，请用简洁自然的方式把以下内容总结后告知家人，不超过 200 字]\n\n${result.transcript.slice(0, 2000)}\n\n文件路径（仅供 send_file 使用）：${result.relativePath}`;
      } else {
        followUpPrompt = `${memberTag}[系统：视频收到了，但语音转录没有识别到内容（可能是纯画面视频）。请告知家人转录结果为空，并询问是否需要其他帮助。文件已保存：${result.relativePath}]`;
      }
    } else if (type === 'image_analysis') {
      if (result.imageDesc) {
        followUpPrompt = `${memberTag}[系统：图片识别完成，内容如下，请简洁回复家人]\n\n${result.imageDesc}\n\n文件路径（仅供 send_file 使用）：${result.relativePath}`;
      } else {
        followUpPrompt = `${memberTag}[系统：图片已收到但识别失败，请告知家人，并建议重发或文字描述内容。文件路径：${result.relativePath}]`;
      }
    } else if (task.isPdf) {
      // PDF 作业文件：触发 homework 对话流
      const homeworkDir = path.join(this.ctx.homeaiRoot, 'Family', 'Homework');
      try { fs.mkdirSync(homeworkDir, { recursive: true }); } catch {}
      const safeFilename    = `${Date.now()}-${result.filename}`;
      const homeworkAbsPath = path.join(homeworkDir, safeFilename);
      try { fs.copyFileSync(result.savePath, homeworkAbsPath); } catch {}
      const relHomeworkPath = fs.existsSync(homeworkAbsPath)
        ? path.relative(this.ctx.homeaiRoot, homeworkAbsPath)
        : result.relativePath;
      const HOMEWORK_BASE_URL = process.env.HOMEWORK_BASE_URL ||
        'https://wecom.homeai-wecom-zxl.top/app/homework/pdf_extractor.html';
      const pdfBaseUrl = `${HOMEWORK_BASE_URL}?pdf=${encodeURIComponent(relHomeworkPath)}`;
      const hwSystemPrompt = [
        `[系统：家人发了作业PDF《${result.filename}》，已保存到：${relHomeworkPath}]`,
        ``,
        `请立刻这样做：`,
        `1. 告诉家人：「作业收到了！要处理哪几道错题？告诉我题号就好（比如：3、5、7）」`,
        `2. 等家人回复题号后，把题号填进链接发给Ta（题号用英文逗号分隔）：`,
        `   格式：${pdfBaseUrl}&questions=3,5,7`,
        `3. 告诉家人：「点开链接，页面会自动识别题目区域，确认后点生成就好」`,
        `4. 家人说「好了」「生成了」「搞定了」等类似话时，用 send_file 工具把以下目录里最新的 PDF 发给Ta：`,
        `   目录：Family/Homework`,
        ``,
        `注意：不要自己调任何 homework API，让家人在网页上操作。`,
      ].join('\n');
      followUpPrompt = `${hwSystemPrompt}\n\n${memberTag}（发送了PDF作业文件）`;
    } else {
      // 文本文件：直接读取内容注入 Lucas 上下文，无需 Lucas 自己找文件
      const TEXT_EXTS = ['.md', '.txt', '.json', '.csv', '.html', '.js', '.ts', '.py', '.yaml', '.yml'];
      const fileExt = path.extname(result.filename).toLowerCase();
      let fileContent = '';
      if (TEXT_EXTS.includes(fileExt)) {
        try {
          const raw = fs.readFileSync(result.savePath, 'utf8');
          fileContent = raw.length > 8000 ? raw.slice(0, 8000) + '\n\n[内容过长，已截断至 8000 字]' : raw;
        } catch (_) {}
      }
      if (fileContent) {
        followUpPrompt = `${memberTag}[系统：文件《${result.filename}》已保存，路径：${result.relativePath}。文件内容如下，请根据内容和家人需求回复]\n\n${fileContent}`;
      } else {
        followUpPrompt = `${memberTag}[系统：文件《${result.filename}》已保存，路径：${result.relativePath}。请询问家人如何处理]`;
      }
    }

    // 重试推送
    let lucasReply = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]));
          this.ctx.logger.info('TaskManager Notifier 重试', { taskId: task.taskId, attempt });
        }
        lucasReply = await this.ctx.callGatewayAgent('lucas', followUpPrompt, sessionId, 60000);
        if (lucasReply) break;
      } catch (e) {
        this.ctx.logger.warn('TaskManager Notifier callGateway 失败', {
          taskId: task.taskId, attempt, error: e?.message,
        });
      }
    }

    if (!lucasReply) {
      this.ctx.logger.warn('TaskManager Notifier 所有重试耗尽，放弃推送', { taskId: task.taskId });
      this._update(task, { status: STATUS.FAILED, error: 'Notifier 重试耗尽' });
      await this._deadLetter(task);
      return;
    }

    // 发送结果给用户
    const botClient = this.ctx.getBotClient();
    const target    = isGroup ? chatId : userId;
    let sendOk = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]));
        await botClient.sendMessage(target, {
          msgtype: 'markdown', markdown: { content: lucasReply },
        });
        sendOk = true;
        break;
      } catch (e) {
        this.ctx.logger.warn('TaskManager Notifier sendMessage 失败', {
          taskId: task.taskId, attempt, error: e?.message,
        });
      }
    }

    if (!sendOk) {
      this._update(task, { status: STATUS.FAILED, error: 'sendMessage 重试耗尽' });
      await this._deadLetter(task);
      return;
    }

    // 写入 chatHistory（follow-up 作为独立轮次）
    const mediaLabel = type === 'video_transcription' ? '视频' : type === 'image_analysis' ? '图片' : '文件';
    this.ctx.appendChatHistory(
      histKey,
      `[系统] ${mediaLabel}《${result.filename}》处理完成`,
      lucasReply,
    );

    this._update(task, { status: STATUS.NOTIFIED, notifiedAt: new Date().toISOString() });
    this.ctx.logger.info('TaskManager 任务完成并推送', { taskId: task.taskId, type });
  }

  // ─── Dead Letter ─────────────────────────────────────────────────────────

  async _deadLetter(task) {
    const entry = { ...task, deadAt: new Date().toISOString() };
    const dlFile = path.join(this._taskDir, 'dead-letter.jsonl');
    try {
      fs.appendFileSync(dlFile, JSON.stringify(entry) + '\n');
    } catch {}
    this.ctx.logger.error('TaskManager DEAD LETTER', {
      taskId: task.taskId, type: task.type, userId: task.userId, error: task.error,
    });
  }

  // ─── 磁盘持久化 ──────────────────────────────────────────────────────────

  _save(task) {
    try {
      fs.writeFileSync(
        path.join(this._taskDir, `${task.taskId}.json`),
        JSON.stringify(task, null, 2),
      );
    } catch (e) {
      this.ctx.logger.warn('TaskManager 任务写盘失败', { taskId: task.taskId, error: e.message });
    }
  }

  _update(task, updates) {
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    this._save(task);
  }

  // ─── Watchdog 接口：扫描并重跑卡住的任务 ─────────────────────────────────

  /**
   * 由 gateway-watchdog.js 定期调用。
   * 将超过 stuckMs（默认 10 分钟）仍处于 processing 状态的任务重置为 pending 重跑。
   */
  recoverStuckTasks(stuckMs = 10 * 60 * 1000) {
    let recovered = 0;
    try {
      const files = fs.readdirSync(this._taskDir).filter(f => f.endsWith('.json') && f !== 'dead-letter.jsonl');
      for (const file of files) {
        try {
          const task = JSON.parse(fs.readFileSync(path.join(this._taskDir, file), 'utf8'));
          if (task.status !== STATUS.PROCESSING) continue;
          const age = Date.now() - new Date(task.updatedAt).getTime();
          if (age > stuckMs) {
            this.ctx.logger.warn('TaskManager 发现卡住任务，重置重跑', {
              taskId: task.taskId, ageMin: Math.round(age / 60000),
            });
            this._update(task, { status: STATUS.PENDING });
            this.enqueue(task);
            recovered++;
          }
        } catch {}
      }
    } catch {}
    return recovered;
  }
}

module.exports = { TaskManager };
