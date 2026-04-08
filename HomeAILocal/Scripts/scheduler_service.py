const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');

/**
 * 定时任务服务
 * 负责调度每日股票财报披露推送任务
 */
class SchedulerService {
    constructor() {
        this.isRunning = false;
    }

    /**
     * 设置每日定时任务，8:00 执行
     */
    schedule_daily_task() {
        // 每天早上8点执行（cron表达式：秒 分 时 日 月 周）
        const cronExpression = '0 0 8 * * *';
        
        console.log('正在设置每日定时任务：每天 8:00 执行股票财报披露推送');
        
        const task = cron.schedule(cronExpression, async () => {
            if (this.isRunning) {
                console.log('上一个任务还在执行中，跳过本次执行');
                return;
            }
            
            this.isRunning = true;
            console.log(`开始执行每日任务：${new Date().toISOString()}`);
            
            try {
                await this.executeDailyTask();
                console.log(`每日任务执行完成：${new Date().toISOString()}`);
            } catch (error) {
                console.error('每日任务执行失败：', error);
            } finally {
                this.isRunning = false;
            }
        }, {
            scheduled: false,
            timezone: 'Asia/Shanghai'
        });

        // 启动定时任务
        task.start();
        console.log('定时任务已启动，将在每天 8:00 执行');
        
        return task;
    }

    /**
     * 执行每日推送任务
     * 调用 Python 脚本执行主要逻辑
     */
    async executeDailyTask() {
        return new Promise((resolve, reject) => {
            const scriptPath = path.join(__dirname, 'daily-stock-disclosure.py');
            
            // 使用 spawn 执行 Python 脚本
            const pythonProcess = spawn('python', [scriptPath], {
                cwd: __dirname,
                stdio: ['inherit', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            pythonProcess.stdout.on('data', (data) => {
                stdout += data.toString();
                console.log(`Python输出: ${data}`);
            });

            pythonProcess.stderr.on('data', (data) => {
                stderr += data.toString();
                console.error(`Python错误: ${data}`);
            });

            pythonProcess.on('close', (code) => {
                if (code === 0) {
                    console.log('Python脚本执行成功');
                    resolve({
                        success: true,
                        stdout: stdout,
                        code: code
                    });
                } else {
                    console.error(`Python脚本执行失败，退出码: ${code}`);
                    reject(new Error(`Python脚本执行失败，退出码: ${code}, 错误: ${stderr}`));
                }
            });

            pythonProcess.on('error', (error) => {
                console.error('启动Python脚本失败:', error);
                reject(error);
            });
        });
    }

    /**
     * 停止定时任务
     */
    stop() {
        console.log('停止定时任务服务');
        if (this.task) {
            this.task.stop();
        }
    }
}

module.exports = SchedulerService;