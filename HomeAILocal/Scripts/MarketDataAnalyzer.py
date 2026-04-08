import pandas as pd
import json
import logging
from typing import Dict, List, Any
import requests
from datetime import datetime, timedelta
import numpy as np

class MarketDataAnalyzer:
    def __init__(self, ollama_host: str = "http://localhost:11434"):
        """
        初始化市场数据分析器
        
        Args:
            ollama_host: Ollama服务地址
        """
        self.ollama_host = ollama_host
        self.logger = logging.getLogger(__name__)
        
    def analyze_market_data(self, market_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        分析市场数据并生成报告内容
        
        Args:
            market_data: 包含各个平台数据的字典
            
        Returns:
            分析结果字典，包含趋势分析、价格对比等信息
        """
        try:
            # 数据预处理
            processed_data = self._preprocess_data(market_data)
            
            # 价格趋势分析
            price_analysis = self._analyze_price_trends(processed_data)
            
            # 产品对比分析
            product_comparison = self._compare_products(processed_data)
            
            # 市场热点分析
            hot_topics = self._identify_hot_topics(processed_data)
            
            # 生成AI分析报告
            ai_insights = self._generate_ai_insights(processed_data)
            
            # 汇总分析结果
            analysis_result = {
                'timestamp': datetime.now().isoformat(),
                'data_sources': list(market_data.keys()),
                'price_analysis': price_analysis,
                'product_comparison': product_comparison,
                'hot_topics': hot_topics,
                'ai_insights': ai_insights,
                'summary': self._generate_summary(price_analysis, product_comparison, hot_topics)
            }
            
            self.logger.info(f"市场数据分析完成，分析了 {len(market_data)} 个数据源")
            return analysis_result
            
        except Exception as e:
            self.logger.error(f"市场数据分析失败: {str(e)}")
            raise
    
    def _preprocess_data(self, market_data: Dict[str, Any]) -> pd.DataFrame:
        """
        预处理市场数据，转换为统一格式的DataFrame
        
        Args:
            market_data: 原始市场数据
            
        Returns:
            处理后的DataFrame
        """
        all_products = []
        
        for source, data in market_data.items():
            if 'products' in data and isinstance(data['products'], list):
                for product in data['products']:
                    # 统一产品信息格式
                    product_info = {
                        'source': source,
                        'name': product.get('name', ''),
                        'price': self._parse_price(product.get('price', 0)),
                        'specs': product.get('specs', {}),
                        'description': product.get('description', ''),
                        'availability': product.get('availability', 'unknown'),
                        'url': product.get('url', ''),
                        'timestamp': product.get('timestamp', datetime.now().isoformat())
                    }
                    
                    # 提取关键规格参数
                    specs = product_info['specs']
                    product_info.update({
                        'gpu_model': specs.get('gpu', ''),
                        'memory': self._parse_memory(specs.get('memory', '')),
                        'cpu_cores': self._parse_cpu_cores(specs.get('cpu', '')),
                        'storage': self._parse_storage(specs.get('storage', ''))
                    })
                    
                    all_products.append(product_info)
        
        df = pd.DataFrame(all_products)
        
        # 数据清洗
        if not df.empty:
            # 去重
            df = df.drop_duplicates(subset=['name', 'source'], keep='last')
            
            # 处理缺失值
            df['price'] = df['price'].fillna(0)
            df['memory'] = df['memory'].fillna(0)
            df['cpu_cores'] = df['cpu_cores'].fillna(0)
            df['storage'] = df['storage'].fillna(0)
            
            # 转换数据类型
            df['price'] = pd.to_numeric(df['price'], errors='coerce')
            df['memory'] = pd.to_numeric(df['memory'], errors='coerce')
            df['cpu_cores'] = pd.to_numeric(df['cpu_cores'], errors='coerce')
            df['storage'] = pd.to_numeric(df['storage'], errors='coerce')
        
        return df
    
    def _analyze_price_trends(self, df: pd.DataFrame) -> Dict[str, Any]:
        """
        分析价格趋势
        
        Args:
            df: 处理后的产品数据DataFrame
            
        Returns:
            价格趋势分析结果
        """
        if df.empty:
            return {'error': '无有效价格数据'}
        
        # 按来源分析价格
        price_by_source = df.groupby('source')['price'].agg(['mean', 'min', 'max', 'count']).round(2)
        
        # 按GPU型号分析价格
        gpu_price_analysis = {}
        if 'gpu_model' in df.columns:
            gpu_groups = df[df['gpu_model'] != ''].groupby('gpu_model')
            for gpu, group in gpu_groups:
                if len(group) > 0:
                    gpu_price_analysis[gpu] = {
                        'avg_price': float(group['price'].mean()),
                        'min_price': float(group['price'].min()),
                        'max_price': float(group['price'].max()),
                        'count': len(group)
                    }
        
        # 价格区间分布
        price_ranges = {
            '低端 (<5000)': len(df[df['price'] < 5000]),
            '中端 (5000-15000)': len(df[(df['price'] >= 5000) & (df['price'] < 15000)]),
            '高端 (15000-30000)': len(df[(df['price'] >= 15000) & (df['price'] < 30000)]),
            '顶级 (>=30000)': len(df[df['price'] >= 30000])
        }
        
        return {
            'overall_stats': {
                'total_products': len(df),
                'avg_price': float(df['price'].mean()) if len(df) > 0 else 0,
                'min_price': float(df['price'].min()) if len(df) > 0 else 0,
                'max_price': float(df['price'].max()) if len(df) > 0 else 0
            },
            'price_by_source': price_by_source.to_dict('index'),
            'gpu_price_analysis': gpu_price_analysis,
            'price_distribution': price_ranges
        }
    
    def _compare_products(self, df: pd.DataFrame) -> Dict[str, Any]:
        """
        产品对比分析
        
        Args:
            df: 处理后的产品数据DataFrame
            
        Returns:
            产品对比分析结果
        """
        if df.empty:
            return {'error': '无产品数据可供对比'}
        
        # 性价比分析 (基于价格和规格)
        performance_scores = []
        for idx, row in df.iterrows():
            score = 0
            if row['memory'] > 0:
                score += row['memory'] / 1000  # GB转换为分数
            if row['cpu_cores'] > 0:
                score += row['cpu_cores'] * 0.5
            if row['storage'] > 0:
                score += row['storage'] / 10000  # 存储分数
            
            if row['price'] > 0 and score > 0:
                cost_performance = score / (row['price'] / 1000)  # 性价比
                performance_scores.append({
                    'name': row['name'],
                    'source': row['source'],
                    'price': row['price'],
                    'performance_score': score,
                    'cost_performance': cost_performance
                })
        
        # 排序找出最佳性价比产品
        top_performance = sorted(performance_scores, key=lambda x: x['cost_performance'], reverse=True)[:5]
        
        # 各来源产品数量对比
        source_comparison = df.groupby('source').agg({
            'name': 'count',
            'price': ['mean', 'min', 'max']
        }).round(2)
        
        return {
            'top_cost_performance': top_performance,
            'source_comparison': source_comparison.to_dict(),
            'availability_summary': df['availability'].value_counts().to_dict()
        }
    
    def _identify_hot_topics(self, df: pd.DataFrame) -> List[str]:
        """
        识别市场热点话题
        
        Args:
            df: 处理后的产品数据DataFrame
            
        Returns:
            热点话题列表
        """
        hot_topics = []
        
        if df.empty:
            return hot_topics
        
        # 分析GPU型号热度
        if 'gpu_model' in df.columns:
            gpu_counts = df['gpu_model'].value_counts()
            if len(gpu_counts) > 0:
                top_gpu = gpu_counts.index[0]
                hot_topics.append(f"热门GPU: {top_gpu} (出现{gpu_counts.iloc[0]}次)")
        
        # 分析价格热点
        avg_price = df['price'].mean()
        if avg_price > 0:
            if avg_price > 20000:
                hot_topics.append("高端算力产品成为市场主流")
            elif avg_price < 8000:
                hot_topics.append("入门级算力产品价格亲民")
            else:
                hot_topics.append("中端算力产品占据主要市场")
        
        # 分析可用性热点
        availability_counts = df['availability'].value_counts()
        if '现货' in availability_counts and availability_counts['现货'] > len(df) * 0.7:
            hot_topics.append("大多数产品现货充足")
        elif '预订' in availability_counts and availability_counts['预订'] > len(df) * 0.5:
            hot_topics.append("多数产品需要预订，供应偏紧")
        
        return hot_topics
    
    def _generate_ai_insights(self, df: pd.DataFrame) -> str:
        """
        使用Ollama生成AI洞察分析
        
        Args:
            df: 处理后的产品数据DataFrame
            
        Returns:
            AI生成的市场洞察
        """
        try:
            # 准备数据摘要
            data_summary = {
                'total_products': len(df),
                'sources': df['source'].nunique() if not df.empty else 0,
                'avg_price': float(df['price'].mean()) if not df.empty else 0,
                'price_range': f"{float(df['price'].min())}-{float(df['price'].max())}" if not df.empty else "0-0"
            }
            
            # 构建提示词
            prompt = f"""作为AI算力市场分析专家，请基于以下数据生成简洁的市场洞察：

数据概况：
- 总产品数：{data_summary['total_products']}
- 数据源数量：{data_summary['sources']}
- 平均价格：{data_summary['avg_price']:.2f}元
- 价格区间：{data_summary['price_range']}元

请提供3-5个关键洞察，每个不超过50字，重点关注：
1. 市场趋势
2. 价格竞争力
3. 产品供应状况
4. 投资建议

请用中文回答，格式简洁明了。"""

            # 调用Ollama API
            response = requests.post(
                f"{self.ollama_host}/api/generate",
                json={
                    "model": "qwen2.5:7b",  # 使用轻量级模型
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": 0.7,
                        "top_p": 0.9,
                        "max_tokens": 500
                    }
                },
                timeout=30
            )
            
            if response.status_code == 200:
                result = response.json()
                return result.get('response', '暂无AI洞察分析')
            else:
                self.logger.warning(f"Ollama API调用失败: {response.status_code}")
                return "AI分析服务暂时不可用"
                
        except Exception as e:
            self.logger.error(f"AI洞察生成失败: {str(e)}")
            return "AI洞察生成失败，请检查Ollama服务状态"
    
    def _generate_summary(self, price_analysis: Dict, product_comparison: Dict, hot_topics: List[str]) -> str:
        """
        生成分析摘要
        
        Args:
            price_analysis: 价格分析结果
            product_comparison: 产品对比结果
            hot_topics: 热点话题
            
        Returns:
            分析摘要文本
        """
        summary_parts = []
        
        # 价格摘要
        if 'overall_stats' in price_analysis:
            stats = price_analysis['overall_stats']
            summary_parts.append(f"本期共收录{stats['total_products']}款AI算力产品")
            if stats['avg_price'] > 0:
                summary_parts.append(f"平均价格{stats['avg_price']:.0f}元")
        
        # 热点摘要
        if hot_topics:
            summary_parts.append(f"市场热点：{hot_topics[0]}")
        
        # 性价比摘要
        if 'top_cost_performance' in product_comparison and product_comparison['top_cost_performance']:
            best_product = product_comparison['top_cost_performance'][0]
            summary_parts.append(f"最佳性价比产品：{best_product['name']}")
        
        return "；".join(summary_parts) + "。"
    
    def _parse_price(self, price_str: Any) -> float:
        """解析价格字符串为数值"""
        if isinstance(price_str, (int, float)):
            return float(price_str)
        
        if isinstance(price_str, str):
            # 移除货币符号和其他字符，提取数字
            import re
            numbers = re.findall(r'\d+\.?\d*', price_str.replace(',', ''))
            if numbers:
                return float(numbers[0])
        
        return 0.0
    
    def _parse_memory(self, memory_str: str) -> float:
        """解析内存规格为GB数值"""
        if not isinstance(memory_str, str):
            return 0.0
        
        import re
        # 查找数字+GB/TB格式
        match = re.search(r'(\d+(?:\.\d+)?)\s*(GB|TB)', memory_str.upper())
        if match:
            value = float(match.group(1))
            unit = match.group(2)
            return value * 1024 if unit == 'TB' else value
        
        return 0.0
    
    def _parse_cpu_cores(self, cpu_str: str) -> int:
        """解析CPU核心数"""
        if not isinstance(cpu_str, str):
            return 0
        
        import re
        # 查找核心数信息
        match = re.search(r'(\d+)\s*[核心cores]', cpu_str)
        if match:
            return int(match.group(1))
        
        return 0
    
    def _parse_storage(self, storage_str: str) -> float:
        """解析存储容量为GB数值"""
        if not isinstance(storage_str, str):
            return 0.0
        
        import re
        # 查找数字+GB/TB/SSD格式
        match = re.search(r'(\d+(?:\.\d+)?)\s*(GB|TB)', storage_str.upper())
        if match:
            value = float(match.group(1))
            unit = match.group(2)
            return value * 1024 if unit == 'TB' else value
        
        return 0.0

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)