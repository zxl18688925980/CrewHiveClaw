#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 算力盒子市场调研报告生成主脚本（修复版）
每周自动生成并发送市场调研报告到企业微信群
"""

import sys
import os
import logging
from datetime import datetime, timedelta
from pathlib import Path

# 添加项目根目录到 Python 路径
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

# 修复导入路径 - 直接从 scripts 目录导入
from MarketDataFetcher import MarketDataFetcher
from MarketDataAnalyzer import MarketDataAnalyzer
from ReportGenerator import ReportGenerator
from WeComNotifier import WeComNotifier

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(project_root / 'logs' / 'weekly_report.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

def main():
    """
    主函数：协调各模块生成并发送 AI 算力盒子市场调研报告
    """
    try:
        logger.info("开始执行 AI 算力盒子市场调研报告生成任务")
        
        # 1. 初始化各模块
        logger.info("初始化数据抓取器...")
        data_fetcher = MarketDataFetcher()
        
        logger.info("初始化数据分析器...")
        data_analyzer = MarketDataAnalyzer()
        
        logger.info("初始化报告生成器...")
        report_generator = ReportGenerator()
        
        logger.info("初始化企业微信通知器...")
        wecom_notifier = WeComNotifier()
        
        # 2. 抓取市场数据
        logger.info("开始抓取 AI 算力盒子市场数据...")
        raw_data = data_fetcher.fetch_market_data()
        
        if not raw_data:
            logger.error("未能获取到市场数据，停止执行")
            return False
            
        logger.info(f"成功抓取 {len(raw_data)} 条市场数据")
        
        # 3. 分析市场数据
        logger.info("开始分析市场数据...")
        analysis_result = data_analyzer.analyze_data(raw_data)
        
        if not analysis_result:
            logger.error("数据分析失败，停止执行")
            return False
            
        logger.info("市场数据分析完成")
        
        # 4. 生成报告
        logger.info("开始生成市场调研报告...")
        report_content = report_generator.generate_report(analysis_result)
        
        if not report_content:
            logger.error("报告生成失败，停止执行")
            return False
            
        logger.info("市场调研报告生成完成")
        
        # 5. 发送报告到企业微信群
        logger.info("开始发送报告到企业微信群...")
        send_result = wecom_notifier.send_report(report_content)
        
        if not send_result:
            logger.error("报告发送失败")
            return False
            
        logger.info("报告已成功发送到企业微信群")
        
        # 6. 保存报告到本地
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        report_file = project_root / 'reports' / f'ai_box_report_{timestamp}.md'
        
        # 确保报告目录存在
        report_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(report_file, 'w', encoding='utf-8') as f:
            f.write(report_content)
            
        logger.info(f"报告已保存到本地: {report_file}")
        
        logger.info("AI 算力盒子市场调研报告生成任务执行完成")
        return True
        
    except Exception as e:
        logger.error(f"执行过程中发生错误: {str(e)}", exc_info=True)
        
        # 发送错误通知到企业微信群
        try:
            error_msg = f"🚨 AI 算力盒子市场调研报告生成失败\n\n" \
                       f"错误时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n" \
                       f"错误信息: {str(e)}"
            
            wecom_notifier = WeComNotifier()
            wecom_notifier.send_error_notification(error_msg)
            
        except Exception as notify_error:
            logger.error(f"发送错误通知失败: {str(notify_error)}")
        
        return False

def check_environment():
    """
    检查运行环境和依赖
    """
    logger.info("检查运行环境...")
    
    # 检查必要的目录
    required_dirs = ['logs', 'reports', 'data']
    for dir_name in required_dirs:
        dir_path = project_root / dir_name
        dir_path.mkdir(parents=True, exist_ok=True)
        logger.info(f"目录 {dir_name} 已准备就绪")
    
    # 检查环境变量
    required_env_vars = [
        'ANTHROPIC_API_KEY',
        'WECOM_WEBHOOK_URL',
        'WECOM_BOT_KEY'
    ]
    
    missing_vars = []
    for var in required_env_vars:
        if not os.getenv(var):
            missing_vars.append(var)
    
    if missing_vars:
        logger.error(f"缺少必要的环境变量: {', '.join(missing_vars)}")
        return False
    
    logger.info("环境检查通过")
    return True

if __name__ == "__main__":
    try:
        # 检查运行环境
        if not check_environment():
            logger.error("环境检查失败，程序退出")
            sys.exit(1)
        
        # 执行主任务
        success = main()
        
        if success:
            logger.info("程序执行成功")
            sys.exit(0)
        else:
            logger.error("程序执行失败")
            sys.exit(1)
            
    except KeyboardInterrupt:
        logger.info("程序被用户中断")
        sys.exit(1)
    except Exception as e:
        logger.error(f"程序异常退出: {str(e)}", exc_info=True)
        sys.exit(1)