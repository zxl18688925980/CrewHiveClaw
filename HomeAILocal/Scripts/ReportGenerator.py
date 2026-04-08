import os
import json
import logging
from datetime import datetime
from typing import Dict, Any
import requests
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class ReportGenerator:
    """AI算力盒子市场调研报告生成器"""
    
    def __init__(self):
        """初始化报告生成器"""
        self.api_key = os.getenv('ANTHROPIC_API_KEY')
        if not self.api_key:
            raise ValueError("ANTHROPIC_API_KEY not found in environment variables")
        
        self.api_url = "https://api.anthropic.com/v1/messages"
        self.model = "claude-3-sonnet-20240229"
        self.reports_dir = "reports"
        
        # 确保报告目录存在
        os.makedirs(self.reports_dir, exist_ok=True)
    
    def _call_claude_api(self, prompt: str) -> str:
        """调用Claude API生成报告内容"""
        headers = {
            'Content-Type': 'application/json',
            'x-api-key': self.api_key,
            'anthropic-version': '2023-06-01'
        }
        
        data = {
            "model": self.model,
            "max_tokens": 4000,
            "temperature": 0.3,
            "messages": [
                {
                    "role": "user",
                    "content": prompt
                }
            ]
        }
        
        try:
            response = requests.post(self.api_url, headers=headers, json=data, timeout=60)
            response.raise_for_status()
            
            result = response.json()
            return result['content'][0]['text']
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Claude API调用失败: {e}")
            raise
        except KeyError as e:
            logger.error(f"Claude API响应格式错误: {e}")
            raise
    
    def _create_report_prompt(self, analysis_data: Dict[str, Any]) -> str:
        """创建报告生成的提示词"""
        current_date = datetime.now().strftime("%Y年%m月%d日")
        
        prompt = f"""
请基于以下AI算力盒子市场数据分析结果，生成一份专业的市场调研周报。

分析数据：
{json.dumps(analysis_data, ensure_ascii=False, indent=2)}

报告要求：
1. 报告标题：AI算力盒子市场调研周报 - {current_date}
2. 报告结构：
   - 市场概述
   - 价格动态分析
   - 产品特性趋势
   - 供应商竞争格局
   - 市场风险提示
   - 下周关注要点

3. 写作风格：
   - 语言专业、客观
   - 数据支撑观点
   - 突出关键信息
   - 提供可操作建议

4. 格式要求：
   - 使用Markdown格式
   - 合理使用标题层级
   - 重要数据用表格展示
   - 关键信息用加粗强调

请生成完整的报告内容：
"""
        return prompt
    
    def _save_report(self, report_content: str) -> str:
        """保存报告到本地文件"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"ai_box_market_report_{timestamp}.md"
        filepath = os.path.join(self.reports_dir, filename)
        
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(report_content)
            
            logger.info(f"报告已保存到: {filepath}")
            return filepath
            
        except IOError as e:
            logger.error(f"保存报告文件失败: {e}")
            raise
    
    def _validate_analysis_data(self, analysis_data: Dict[str, Any]) -> bool:
        """验证分析数据的完整性"""
        required_keys = ['price_analysis', 'product_features', 'market_trends', 'supplier_analysis']
        
        for key in required_keys:
            if key not in analysis_data:
                logger.warning(f"分析数据缺少必需字段: {key}")
                return False
        
        return True
    
    def generate_report(self, analysis_data: Dict[str, Any]) -> str:
        """
        根据分析结果生成市场调研报告
        
        Args:
            analysis_data: 市场数据分析结果字典
            
        Returns:
            str: 生成的报告文件路径
        """
        try:
            logger.info("开始生成市场调研报告...")
            
            # 验证输入数据
            if not analysis_data:
                raise ValueError("分析数据不能为空")
            
            if not self._validate_analysis_data(analysis_data):
                logger.warning("分析数据不完整，但继续生成报告")
            
            # 创建提示词
            prompt = self._create_report_prompt(analysis_data)
            
            # 调用Claude API生成报告
            logger.info("正在调用Claude API生成报告内容...")
            report_content = self._call_claude_api(prompt)
            
            # 保存报告文件
            filepath = self._save_report(report_content)
            
            logger.info("市场调研报告生成完成")
            return filepath
            
        except Exception as e:
            logger.error(f"生成报告时发生错误: {e}")
            raise

if __name__ == "__main__":
    # 测试代码
    test_analysis_data = {
        "price_analysis": {
            "average_price": 8500,
            "price_trend": "上涨",
            "price_range": "6000-12000"
        },
        "product_features": {
            "主流配置": "RTX 4090, 128GB RAM",
            "新兴趋势": "AI专用芯片集成"
        },
        "market_trends": {
            "需求增长": "20%",
            "供应紧张": "中等"
        },
        "supplier_analysis": {
            "主要供应商": ["厂商A", "厂商B", "厂商C"],
            "市场份额变化": "厂商A份额提升"
        }
    }
    
    generator = ReportGenerator()
    try:
        report_path = generator.generate_report(test_analysis_data)
        print(f"测试报告生成成功: {report_path}")
    except Exception as e:
        print(f"测试失败: {e}")