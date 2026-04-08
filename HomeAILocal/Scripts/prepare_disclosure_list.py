#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
财报披露清单准备模块
职责：过滤未来4天内的财报披露计划，生成推送清单
"""

import logging
from datetime import datetime, timedelta
from typing import List, Dict, Any
import pandas as pd
from fetch_stock_disclosure_calendar import FetchStockDisclosureCalendar

logger = logging.getLogger(__name__)

class PrepareDisclosureList:
    """财报披露清单准备器"""
    
    def __init__(self):
        self.fetcher = FetchStockDisclosureCalendar()
        
    def prepare_future_four_days_disclosures(self) -> List[Dict[str, Any]]:
        """
        准备未来4天内有财报披露计划的上市公司列表
        
        Returns:
            List[Dict]: 包含股票代码、名称、披露日期等信息的列表
        """
        try:
            logger.info("开始准备未来4天财报披露清单")
            
            # 获取财报披露日历数据
            disclosure_data = self.fetcher.fetch_and_parse_disclosure_dates()
            
            if not disclosure_data:
                logger.warning("未获取到财报披露数据")
                return []
            
            # 计算未来4天的日期范围
            today = datetime.now().date()
            future_4_days = today + timedelta(days=4)
            
            logger.info(f"筛选日期范围：{today} 至 {future_4_days}")
            
            # 过滤未来4天内的披露计划
            filtered_disclosures = []
            
            for item in disclosure_data:
                try:
                    # 解析披露日期
                    disclosure_date_str = item.get('披露日期', '')
                    if not disclosure_date_str:
                        continue
                        
                    # 处理不同的日期格式
                    if isinstance(disclosure_date_str, str):
                        try:
                            disclosure_date = datetime.strptime(disclosure_date_str, '%Y-%m-%d').date()
                        except ValueError:
                            try:
                                disclosure_date = datetime.strptime(disclosure_date_str, '%Y/%m/%d').date()
                            except ValueError:
                                logger.warning(f"无法解析日期格式：{disclosure_date_str}")
                                continue
                    else:
                        # 如果已经是 datetime 对象
                        disclosure_date = disclosure_date_str.date() if hasattr(disclosure_date_str, 'date') else disclosure_date_str
                    
                    # 筛选未来4天内的数据
                    if today <= disclosure_date <= future_4_days:
                        disclosure_info = {
                            'stock_code': item.get('股票代码', ''),
                            'stock_name': item.get('股票名称', ''),
                            'disclosure_date': disclosure_date.strftime('%Y-%m-%d'),
                            'report_type': item.get('报告类型', ''),
                            'report_period': item.get('报告期', ''),
                            'days_until_disclosure': (disclosure_date - today).days
                        }
                        
                        # 验证必要字段
                        if disclosure_info['stock_code'] and disclosure_info['stock_name']:
                            filtered_disclosures.append(disclosure_info)
                        
                except Exception as e:
                    logger.error(f"处理单条披露记录时出错：{e}")
                    continue
            
            # 按披露日期排序
            filtered_disclosures.sort(key=lambda x: x['disclosure_date'])
            
            logger.info(f"成功准备{len(filtered_disclosures)}条未来4天财报披露记录")
            
            # 记录详细信息用于调试
            for item in filtered_disclosures[:5]:  # 只记录前5条
                logger.debug(f"披露计划：{item['stock_name']}({item['stock_code']}) - {item['disclosure_date']}")
            
            return filtered_disclosures
            
        except Exception as e:
            logger.error(f"准备财报披露清单时发生错误：{e}")
            raise

    def format_disclosure_message(self, disclosures: List[Dict[str, Any]]) -> str:
        """
        格式化财报披露信息为微信消息格式
        
        Args:
            disclosures: 财报披露列表
            
        Returns:
            str: 格式化的消息文本
        """
        if not disclosures:
            return "📊 未来4天暂无A股财报披露计划"
        
        message_lines = ["📊 未来4天A股财报披露计划", ""]
        
        # 按日期分组
        from collections import defaultdict
        grouped_by_date = defaultdict(list)
        
        for item in disclosures:
            grouped_by_date[item['disclosure_date']].append(item)
        
        for date in sorted(grouped_by_date.keys()):
            items = grouped_by_date[date]
            date_obj = datetime.strptime(date, '%Y-%m-%d')
            weekday = date_obj.strftime('%A')
            
            message_lines.append(f"📅 {date} ({weekday})")
            
            for item in items[:10]:  # 每天最多显示10条
                message_lines.append(f"  • {item['stock_name']}({item['stock_code']}) - {item['report_type']}")
            
            if len(items) > 10:
                message_lines.append(f"  ... 还有{len(items) - 10}家公司")
            
            message_lines.append("")
        
        message_lines.append(f"总计：{len(disclosures)}家上市公司")
        message_lines.append("⏰ 每日8:00自动推送")
        
        return "\n".join(message_lines)

def prepare_future_four_days_disclosures() -> List[Dict[str, Any]]:
    """
    全局函数：准备未来4天内有财报披露计划的上市公司列表
    
    Returns:
        List[Dict]: 包含股票代码、名称、披露日期等信息的列表
    """
    preparer = PrepareDisclosureList()
    return preparer.prepare_future_four_days_disclosures()

if __name__ == "__main__":
    # 配置日志
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    # 测试运行
    try:
        disclosures = prepare_future_four_days_disclosures()
        preparer = PrepareDisclosureList()
        message = preparer.format_disclosure_message(disclosures)
        print(message)
        
    except Exception as e:
        logger.error(f"测试运行失败：{e}")