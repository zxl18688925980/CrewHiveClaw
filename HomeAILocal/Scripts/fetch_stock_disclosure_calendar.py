#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
财报披露日历获取模块
功能：获取并解析A股上市公司的财报预约披露日期表
"""

import akshare as ak
import pandas as pd
import logging
from datetime import datetime, timedelta
from typing import List, Dict, Optional

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class FetchStockDisclosureCalendar:
    """A股财报披露日历获取器"""
    
    def __init__(self):
        """初始化"""
        self.disclosure_data = None
    
    def fetch_and_parse_disclosure_dates(self) -> List[Dict]:
        """
        获取并解析A股上市公司的财报预约披露日期表
        
        Returns:
            List[Dict]: 包含股票代码、名称、披露日期等信息的字典列表
        """
        try:
            logger.info("开始获取A股财报预约披露日期表...")
            
            # 调用akshare获取财报预约披露日期表
            disclosure_df = ak.stock_report_disclosure()
            
            if disclosure_df is None or disclosure_df.empty:
                logger.warning("未获取到财报披露数据")
                return []
            
            logger.info(f"成功获取到 {len(disclosure_df)} 条财报披露记录")
            
            # 解析数据并筛选未来4天内的披露计划
            parsed_data = self._parse_disclosure_data(disclosure_df)
            
            # 筛选未来4天内的数据
            filtered_data = self._filter_upcoming_disclosures(parsed_data, days=4)
            
            logger.info(f"筛选出未来4天内有财报披露计划的公司：{len(filtered_data)} 家")
            
            self.disclosure_data = filtered_data
            return filtered_data
            
        except Exception as e:
            logger.error(f"获取财报披露日期表失败: {str(e)}")
            raise
    
    def _parse_disclosure_data(self, df: pd.DataFrame) -> List[Dict]:
        """
        解析财报披露数据
        
        Args:
            df: akshare返回的原始数据框
            
        Returns:
            List[Dict]: 解析后的数据列表
        """
        parsed_data = []
        
        try:
            for _, row in df.iterrows():
                # 解析数据行，根据akshare返回的列名进行处理
                stock_info = {
                    'stock_code': str(row.get('股票代码', '')),
                    'stock_name': str(row.get('股票简称', '')),
                    'disclosure_date': str(row.get('预约披露日期', '')),
                    'report_period': str(row.get('报告期', '')),
                    'report_type': str(row.get('报告类型', ''))
                }
                
                # 数据清洗和验证
                if self._validate_stock_info(stock_info):
                    parsed_data.append(stock_info)
                    
        except Exception as e:
            logger.error(f"解析财报披露数据时出错: {str(e)}")
            raise
        
        return parsed_data
    
    def _validate_stock_info(self, stock_info: Dict) -> bool:
        """
        验证股票信息的有效性
        
        Args:
            stock_info: 股票信息字典
            
        Returns:
            bool: 数据是否有效
        """
        # 检查必要字段是否存在且不为空
        required_fields = ['stock_code', 'stock_name', 'disclosure_date']
        
        for field in required_fields:
            if not stock_info.get(field) or stock_info.get(field) == 'nan':
                return False
        
        # 检查股票代码格式（A股代码通常为6位数字）
        stock_code = stock_info['stock_code']
        if not stock_code.isdigit() or len(stock_code) != 6:
            return False
        
        # 检查披露日期格式
        try:
            datetime.strptime(stock_info['disclosure_date'], '%Y-%m-%d')
        except ValueError:
            return False
        
        return True
    
    def _filter_upcoming_disclosures(self, data: List[Dict], days: int = 4) -> List[Dict]:
        """
        筛选未来指定天数内的财报披露计划
        
        Args:
            data: 财报披露数据列表
            days: 未来天数，默认4天
            
        Returns:
            List[Dict]: 筛选后的数据列表
        """
        filtered_data = []
        today = datetime.now().date()
        target_date = today + timedelta(days=days)
        
        for item in data:
            try:
                disclosure_date = datetime.strptime(item['disclosure_date'], '%Y-%m-%d').date()
                
                # 筛选未来4天内（包含今天）的披露计划
                if today <= disclosure_date <= target_date:
                    # 添加剩余天数信息
                    days_left = (disclosure_date - today).days
                    item['days_remaining'] = days_left
                    filtered_data.append(item)
                    
            except ValueError as e:
                logger.warning(f"日期解析失败，跳过记录: {item.get('stock_code', 'Unknown')} - {str(e)}")
                continue
        
        # 按披露日期排序
        filtered_data.sort(key=lambda x: x['disclosure_date'])
        
        return filtered_data
    
    def get_disclosure_summary(self) -> Dict:
        """
        获取披露摘要信息
        
        Returns:
            Dict: 包含统计信息的摘要
        """
        if not self.disclosure_data:
            return {'total_count': 0, 'by_date': {}}
        
        summary = {
            'total_count': len(self.disclosure_data),
            'by_date': {},
            'by_report_type': {}
        }
        
        # 按日期分组统计
        for item in self.disclosure_data:
            date = item['disclosure_date']
            report_type = item.get('report_type', '未知')
            
            if date not in summary['by_date']:
                summary['by_date'][date] = 0
            summary['by_date'][date] += 1
            
            if report_type not in summary['by_report_type']:
                summary['by_report_type'][report_type] = 0
            summary['by_report_type'][report_type] += 1
        
        return summary

# 便捷函数
def fetch_and_parse_disclosure_dates() -> List[Dict]:
    """
    便捷函数：获取并解析财报披露日期
    
    Returns:
        List[Dict]: 财报披露数据列表
    """
    fetcher = FetchStockDisclosureCalendar()
    return fetcher.fetch_and_parse_disclosure_dates()

if __name__ == "__main__":
    # 测试代码
    try:
        fetcher = FetchStockDisclosureCalendar()
        data = fetcher.fetch_and_parse_disclosure_dates()
        
        print(f"获取到 {len(data)} 家公司的财报披露计划")
        
        # 打印前5条记录用于测试
        for i, item in enumerate(data[:5]):
            print(f"{i+1}. {item['stock_name']}({item['stock_code']}) - {item['disclosure_date']} - 剩余{item['days_remaining']}天")
        
        # 打印摘要信息
        summary = fetcher.get_disclosure_summary()
        print(f"\n摘要信息: {summary}")
        
    except Exception as e:
        logger.error(f"测试运行失败: {str(e)}")