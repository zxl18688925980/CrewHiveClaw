#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
主入口模块 - 串联全流程
"""

import os
import sys
import datetime

# 添加模块路径
sys.path.insert(0, os.path.dirname(__file__))

import config
import storage
import fetcher
import detector
import reporter
import pusher


def main():
    """主流程入口"""
    print("=" * 60)
    print(f"A股年报监控系统启动 - {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)
    
    # 1. 初始化数据库
    print("\n[步骤1] 初始化数据库...")
    try:
        storage.init_db()
    except Exception as e:
        print(f"数据库初始化失败: {e}")
        print("检查一下是否有写入权限。")
        return 1
    
    # 2. 检查监控列表
    watchlist = config.WATCHLIST
    if not watchlist:
        print("\n⚠️  监控股票列表为空！")
        print("请在 config.py 中添加需要监控的股票代码。")
        print("示例: WATCHLIST = ['000001', '000002']")
        return 0
    
    print(f"\n[步骤2] 监控股票池: {watchlist}")
    
    # 3. 遍历股票，抓取数据
    print("\n[步骤3] 开始抓取数据...")
    all_anomalies = []
    
    for stock_code in watchlist:
        try:
            print(f"\n--- 处理股票: {stock_code} ---")
            
            # 抓取当前数据
            current_data = fetcher.fetch_annual_report_info(stock_code)
            
            # 如果真实抓取失败，使用模拟数据（测试阶段）
            if not current_data:
                print(f"真实抓取失败，使用模拟数据进行测试...")
                current_data = fetcher.fetch_mock_data(stock_code)
            
            if not current_data:
                print(f"无法获取股票 {stock_code} 的数据，跳过")
                continue
            
            # 获取历史数据
            report_year = current_data.get("report_year", datetime.datetime.now().year - 1)
            previous_data = storage.get_previous_report(stock_code, report_year)
            
            # 检测异常
            anomalies = detector.detect_anomalies(current_data, previous_data)
            
            # 去重：检查是否已推送
            new_anomalies = []
            for anomaly in anomalies:
                anomaly_type = anomaly.get("type")
                if not storage.is_already_reported(stock_code, anomaly_type):
                    new_anomalies.append(anomaly)
                else:
                    print(f"  已跳过重复异常: {anomaly_type}")
            
            all_anomalies.extend(new_anomalies)
            
            # 保存当前数据
            storage.save_report(stock_code, current_data)
            
        except Exception as e:
            print(f"处理股票 {stock_code} 时出错: {e}")
            continue
    
    # 4. 生成日报
    print(f"\n[步骤4] 生成日报...")
    report = reporter.generate_daily_report(all_anomalies)
    
    # 保存日报到文件
    log_dir = config.LOG_PATH
    os.makedirs(log_dir, exist_ok=True)
    
    timestamp = datetime.datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    report_file = os.path.join(log_dir, f"daily-report-{timestamp}.md")
    
    with open(report_file, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"日报已保存: {report_file}")
    
    # 5. 推送日报
    print(f"\n[步骤5] 推送日报...")
    if all_anomalies:
        result = pusher.push_daily_report(report)
        
        if result.get("errcode") == 0:
            print(f"日报已推送给 {config.PUSH_CONFIG['target_user']} ✓")
            
            # 标记已推送
            for anomaly in all_anomalies:
                stock_code = anomaly.get("stock_code")
                anomaly_type = anomaly.get("type")
                detail = anomaly.get("detail", "")
                storage.mark_as_reported(stock_code, anomaly_type, detail)
        else:
            print(f"推送失败: {result.get('errmsg', '未知错误')}")
    else:
        print("无异常，不推送日报")
    
    # 6. 完成
    print("\n" + "=" * 60)
    print(f"监控完成 - 发现 {len(all_anomalies)} 条异常")
    print("=" * 60)
    
    return 0


def test_single_stock(stock_code: str):
    """测试单个股票的数据抓取"""
    print(f"\n测试抓取股票: {stock_code}")
    print("-" * 40)
    
    # 尝试真实抓取
    data = fetcher.fetch_annual_report_info(stock_code)
    
    if data:
        print("真实抓取成功:")
        for key, value in data.items():
            print(f"  {key}: {value}")
    else:
        print("真实抓取失败，使用模拟数据:")
        data = fetcher.fetch_mock_data(stock_code)
        for key, value in data.items():
            print(f"  {key}: {value}")
    
    return data


def test_push():
    """测试推送功能"""
    print("\n测试推送功能...")
    print("-" * 40)
    
    result = pusher.push_test_message()
    print(f"推送结果: {result}")
    
    return result


if __name__ == "__main__":
    # 检查命令行参数
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        
        if arg == "--test-push":
            # 测试推送
            test_push()
            sys.exit(0)
        
        elif arg == "--test-fetch" and len(sys.argv) > 2:
            # 测试抓取指定股票
            test_single_stock(sys.argv[2])
            sys.exit(0)
        
        elif arg == "--help":
            print("用法:")
            print("  python main.py              # 正常运行")
            print("  python main.py --test-push  # 测试推送")
            print("  python main.py --test-fetch <股票代码>  # 测试抓取")
            sys.exit(0)
    
    # 正常运行
    exit_code = main()
    sys.exit(exit_code)
