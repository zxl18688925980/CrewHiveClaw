from collections import defaultdict
from datetime import datetime
from typing import List, Dict

def format_messages(stock_data: List[Dict]) -> Dict:
    """
    按日期分组并格式化股票财报披露信息
    
    Args:
        stock_data: 包含股票信息的字典列表
                   每个字典包含: stock_code, stock_name, disclosure_date, report_type
    
    Returns:
        Dict: 格式化后的消息字典，key为日期，value为该日期的格式化消息
    """
    if not stock_data:
        return {}
    
    # 按披露日期分组
    grouped_by_date = defaultdict(list)
    for stock in stock_data:
        disclosure_date = stock.get('disclosure_date', '')
        if disclosure_date:
            grouped_by_date[disclosure_date].append(stock)
    
    formatted_messages = {}
    
    # 对每个日期进行排序处理
    for date in sorted(grouped_by_date.keys()):
        stocks = grouped_by_date[date]
        
        # 格式化日期显示
        try:
            date_obj = datetime.strptime(date, '%Y-%m-%d')
            formatted_date = date_obj.strftime('%Y年%m月%d日')
        except:
            formatted_date = date
        
        # 构建当日消息
        message_lines = [f"📊 {formatted_date} 财报披露计划"]
        message_lines.append("=" * 30)
        
        # 按股票代码排序
        sorted_stocks = sorted(stocks, key=lambda x: x.get('stock_code', ''))
        
        for i, stock in enumerate(sorted_stocks, 1):
            stock_code = stock.get('stock_code', '未知代码')
            stock_name = stock.get('stock_name', '未知公司')
            report_type = stock.get('report_type', '定期报告')
            
            # 格式化单个股票信息
            stock_line = f"{i:2d}. {stock_code} {stock_name} ({report_type})"
            message_lines.append(stock_line)
        
        # 添加统计信息
        message_lines.append("")
        message_lines.append(f"📈 共 {len(sorted_stocks)} 家公司披露财报")
        
        # 合并成完整消息
        formatted_messages[date] = "\n".join(message_lines)
    
    return formatted_messages