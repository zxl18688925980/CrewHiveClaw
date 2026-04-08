import akshare as ak
import pandas as pd
from datetime import datetime, timedelta
from typing import List, Dict
import logging

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def fetch_disclosures() -> List[Dict]:
    """
    获取财报披露数据
    
    Returns:
        List[Dict]: 财报披露数据列表，每个字典包含股票代码、名称、披露日期等信息
    """
    try:
        # 获取财报披露数据
        logger.info("开始获取财报披露数据...")
        df = ak.stock_report_disclosure()
        
        if df is None or df.empty:
            logger.warning("未获取到财报披露数据")
            return []
        
        # 获取当前日期和未来3天的日期范围
        today = datetime.now().date()
        end_date = today + timedelta(days=3)
        
        # 确保披露日期列存在并转换为日期格式
        date_column = None
        possible_date_columns = ['披露日期', '公告日期', 'date', 'disclosure_date']
        
        for col in possible_date_columns:
            if col in df.columns:
                date_column = col
                break
        
        if date_column is None:
            logger.error("未找到日期列")
            return []
        
        # 转换日期格式
        try:
            df[date_column] = pd.to_datetime(df[date_column]).dt.date
        except Exception as e:
            logger.error(f"日期转换失败: {e}")
            return []
        
        # 筛选当天及未来3天的数据
        filtered_df = df[
            (df[date_column] >= today) & 
            (df[date_column] <= end_date)
        ]
        
        if filtered_df.empty:
            logger.info("当天及未来3天无财报披露计划")
            return []
        
        # 转换为字典列表
        result = []
        for _, row in filtered_df.iterrows():
            try:
                disclosure_dict = {
                    'stock_code': str(row.get('股票代码', row.get('code', ''))),
                    'stock_name': str(row.get('股票简称', row.get('name', ''))),
                    'disclosure_date': row[date_column].strftime('%Y-%m-%d'),
                    'report_type': str(row.get('报告类型', row.get('report_type', '年报'))),
                    'report_period': str(row.get('报告期', row.get('period', '')))
                }
                
                # 确保必要字段不为空
                if disclosure_dict['stock_code'] and disclosure_dict['stock_name']:
                    result.append(disclosure_dict)
                    
            except Exception as e:
                logger.warning(f"处理行数据时出错: {e}")
                continue
        
        logger.info(f"成功获取 {len(result)} 条财报披露数据")
        return result
        
    except Exception as e:
        logger.error(f"获取财报披露数据失败: {e}")
        return []

if __name__ == "__main__":
    # 测试函数
    disclosures = fetch_disclosures()
    print(f"获取到 {len(disclosures)} 条披露数据")
    for disclosure in disclosures[:5]:  # 打印前5条
        print(disclosure)