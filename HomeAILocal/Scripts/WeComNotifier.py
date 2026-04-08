const axios = require('axios');
require('dotenv').config();

class WeComNotifier {
    constructor() {
        this.webhookUrl = process.env.WECOM_WEBHOOK_URL;
        this.botKey = process.env.WECOM_BOT_KEY;
        
        if (!this.webhookUrl || !this.botKey) {
            throw new Error('企业微信配置缺失：请检查 WECOM_WEBHOOK_URL 和 WECOM_BOT_KEY 环境变量');
        }
    }

    /**
     * 发送报告到企业微信群
     * @param {string} reportText - 报告文本内容
     * @returns {Promise<boolean>} - 发送成功返回true，失败返回false
     */
    async send_report_to_wecom(reportText) {
        try {
            // 构造企业微信消息格式
            const message = {
                msgtype: "markdown",
                markdown: {
                    content: this.formatReportForWecom(reportText)
                }
            };

            // 发送请求到企业微信 Webhook
            const response = await axios.post(
                `${this.webhookUrl}?key=${this.botKey}`,
                message,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            // 检查响应状态
            if (response.status === 200 && response.data.errcode === 0) {
                console.log('✅ 报告已成功发送到企业微信群');
                return true;
            } else {
                console.error('❌ 企业微信发送失败:', response.data);
                return false;
            }

        } catch (error) {
            console.error('❌ 发送报告到企业微信时出错:', error.message);
            
            // 记录详细错误信息
            if (error.response) {
                console.error('响应状态:', error.response.status);
                console.error('响应数据:', error.response.data);
            }
            
            return false;
        }
    }

    /**
     * 格式化报告文本为企业微信 Markdown 格式
     * @param {string} reportText - 原始报告文本
     * @returns {string} - 格式化后的 Markdown 文本
     */
    formatReportForWecom(reportText) {
        // 添加报告标题和时间戳
        const timestamp = new Date().toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });

        let formattedText = `# 🤖 AI算力盒子市场周报\n\n`;
        formattedText += `📅 **生成时间**: ${timestamp}\n\n`;
        formattedText += `---\n\n`;
        
        // 处理报告内容，确保 Markdown 格式正确
        const processedText = reportText
            // 转义特殊字符
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            // 优化标题格式
            .replace(/^(\d+\.\s*)/gm, '## $1')
            .replace(/^([一二三四五六七八九十]+、)/gm, '### $1')
            // 优化列表格式
            .replace(/^[\s]*[-*]\s/gm, '- ')
            // 添加换行确保格式正确
            .replace(/\n{3,}/g, '\n\n');

        formattedText += processedText;
        
        // 添加底部信息
        formattedText += `\n\n---\n`;
        formattedText += `🔗 **数据来源**: 多个AI算力平台官网\n`;
        formattedText += `⚡ **自动生成**: 基于最新市场数据分析\n`;
        formattedText += `📊 **下次更新**: 下周同一时间\n`;

        // 检查消息长度限制（企业微信单条消息最大4096字符）
        if (formattedText.length > 4000) {
            console.warn('⚠️ 报告内容较长，进行截取处理');
            formattedText = formattedText.substring(0, 3900) + '\n\n...\n\n*内容过长已截取，完整报告请查看系统日志*';
        }

        return formattedText;
    }

    /**
     * 发送简单文本消息到企业微信
     * @param {string} text - 文本内容
     * @returns {Promise<boolean>} - 发送结果
     */
    async sendTextMessage(text) {
        try {
            const message = {
                msgtype: "text",
                text: {
                    content: text
                }
            };

            const response = await axios.post(
                `${this.webhookUrl}?key=${this.botKey}`,
                message,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            return response.status === 200 && response.data.errcode === 0;

        } catch (error) {
            console.error('发送文本消息失败:', error.message);
            return false;
        }
    }

    /**
     * 测试企业微信连接
     * @returns {Promise<boolean>} - 连接测试结果
     */
    async testConnection() {
        console.log('🔍 测试企业微信连接...');
        
        const testMessage = `🧪 系统测试消息\n时间: ${new Date().toLocaleString('zh-CN')}`;
        const result = await this.sendTextMessage(testMessage);
        
        if (result) {
            console.log('✅ 企业微信连接测试成功');
        } else {
            console.log('❌ 企业微信连接测试失败');
        }
        
        return result;
    }
}

module.exports = WeComNotifier;