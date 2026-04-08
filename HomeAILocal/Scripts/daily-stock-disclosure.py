#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
主入口脚本，调度任务并执行企业微信推送
执行每日股票财报披露信息的获取、格式化和通知发送
"""

import sys
import os
import logging
from datetime import datetime
from typing import Dict, List, Any, Optional

# 添加当前目录到Python路径，确保能够导入本地模块
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from fetch_stock_disclosures import fetch_disclosures
from format_stock_messages import format_messages
from notify_wechat import send_notification

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('daily_stock_disclosure.log'),
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)

def validate_disclosure_data(disclosures: List[Dict]) -> bool:
    """
    验证获取到的财报披露数据是否有效
    
    Args:
        disclosures: 财报披露数据列表
        
    Returns:
        bool: 数据是否有效
    """
    if not isinstance(disclosures, list):
        logger.error("披露数据不是列表格式")
        return False
    
    if len(disclosures) == 0:
        logger.warning("未获取到财报披露数据")
        return True  # 空数据也是有效的
    
    # 检查数据结构
    required_fields = ['stock_code', 'stock_name', 'disclosure_date']
    for disclosure in disclosures:
        if not isinstance(disclosure, dict):
            logger.error("披露数据项不是字典格式")
            return False
        
        for field in required_fields:
            if field not in disclosure:
                logger.error(f"披露数据缺少必需字段: {field}")
                return False
    
    return True

def validate_formatted_message(message_data: Dict) -> bool:
    """
    验证格式化后的消息数据是否有效
    
    Args:
        message_data: 格式化后的消息数据
        
    Returns:
        bool: 消息数据是否有效
    """
    if not isinstance(message_data, dict):
        logger.error("格式化消息不是字典格式")
        return False
    
    if 'content' not in message_data:
        logger.error("格式化消息缺少content字段")
        return False
    
    if not isinstance(message_data['content'], str):
        logger.error("消息内容不是字符串格式")
        return False
    
    if len(message_data['content'].strip()) == 0:
        logger.error("消息内容为空")
        return False
    
    return True

def handle_error(step: str, error: Exception) -> None:
    """
    统一错误处理
    
    Args:
        step: 出错的步骤名称
        error: 异常对象
    """
    error_msg = f"执行{step}时发生错误: {str(error)}"
    logger.error(error_msg, exc_info=True)

def main() -> bool:
    """
    主函数：执行完整的股票财报披露信息推送流程
    
    Returns:
        bool: 执行是否成功
    """
    start_time = datetime.now()
    logger.info(f"开始执行每日股票财报披露推送任务 - {start_time}")
    
    try:
        # 第一步：获取股票财报披露数据
        logger.info("步骤1: 获取股票财报披露数据")
        disclosures = fetch_disclosures()
        
        # 验证获取的数据
        if not validate_disclosure_data(disclosures):
            logger.error("获取的财报披露数据验证失败")
            return False
        
        logger.info(f"成功获取到 {len(disclosures)} 条财报披露记录")
        
        # 第二步：格式化消息
        logger.info("步骤2: 格式化推送消息")
        message_data = format_messages(disclosures)
        
        # 验证格式化后的消息
        if not validate_formatted_message(message_data):
            logger.error("格式化后的消息验证失败")
            return False
        
        logger.info("消息格式化完成")
        
        # 第三步：发送企业微信通知
        logger.info("步骤3: 发送企业微信通知")
        send_result = send_notification(message_data)
        
        if not isinstance(send_result, bool):
            logger.error("发送通知返回值类型错误，期望bool类型")
            return False
        
        if send_result:
            end_time = datetime.now()
            duration = (end_time - start_time).total_seconds()
            logger.info(f"每日股票财报披露推送任务执行成功 - 耗时: {duration:.2f}秒")
            return True
        else:
            logger.error("企业微信通知发送失败")
            return False
            
    except ImportError as e:
        handle_error("模块导入", e)
        return False
    except Exception as e:
        handle_error("任务执行", e)
        return False
    
    finally:
        # 清理资源（如果需要）
        logger.info("任务执行完毕，进行资源清理")

if __name__ == "__main__":
    """
    脚本直接执行时的入口点
    """
    try:
        success = main()
        exit_code = 0 if success else 1
        logger.info(f"脚本执行完毕，退出码: {exit_code}")
        sys.exit(exit_code)
    except KeyboardInterrupt:
        logger.warning("用户中断执行")
        sys.exit(1)
    except Exception as e:
        logger.critical(f"脚本执行过程中发生未捕获的异常: {str(e)}", exc_info=True)
        sys.exit(1)