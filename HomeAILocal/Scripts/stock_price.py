#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A股实时行情查询（多源冗余 + 缓存降级）
- 主源：akshare（A股专用，延迟 ~3s）
- 备源：yfinance（全球市场，延迟 ~15s）
- 缓存：/tmp/stock_cache/{code}.json，有效期 60s
- 降级：所有源失败时返回最近一次缓存（标注 stale）

用法：
  python3 stock_price.py 300750        # 单只查询
  python3 stock_price.py 300750 000001 # 多只查询
  python3 stock_price.py --api 300750  # JSON 输出（API 模式）
"""

import sys
import os
import json
import time
import re
from datetime import datetime, timezone, timedelta

CST = timezone(timedelta(hours=8))
CACHE_DIR = "/tmp/stock_cache"
CACHE_TTL = 60  # 秒

def ensure_cache_dir():
    os.makedirs(CACHE_DIR, exist_ok=True)

def cache_path(code):
    return os.path.join(CACHE_DIR, f"{code}.json")

def read_cache(code):
    p = cache_path(code)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r") as f:
            data = json.load(f)
        if time.time() - data.get("cached_at", 0) < CACHE_TTL:
            data["stale"] = False
            return data
        # 缓存过期但仍保留（降级用）
        data["stale"] = True
        return data
    except Exception:
        return None

def write_cache(code, data):
    ensure_cache_dir()
    data["cached_at"] = time.time()
    try:
        with open(cache_path(code), "w") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass

def normalize_code(code):
    """规范化 A 股代码：6 位数字，不足补前导零"""
    code = str(code).strip()
    # 去掉可能的前缀（sh/sz/SH/SZ）
    code = re.sub(r'^[sS][hHzZ]', '', code)
    return code.zfill(6)

def is_shanghai(code):
    """6 开头为上交所，其余为深交所"""
    return code.startswith('6')

def query_akshare(code):
    """akshare 主源查询"""
    try:
        import akshare as ak
        code = normalize_code(code)
        # akshare 用 "sh600519" 或 "sz000001" 格式
        prefix = "sh" if is_shanghai(code) else "sz"
        symbol = f"{prefix}{code}"
        df = ak.stock_zh_a_spot_em()
        # df 列：代码, 名称, 最新价, 涨跌幅, 涨跌额, 成交量, 成交额, 振幅, 最高, 最低, 今开, 昨收
        row = df[df['代码'] == code]
        if row.empty:
            return None
        r = row.iloc[0]
        return {
            "code": code,
            "name": str(r.get('名称', '')),
            "price": float(r.get('最新价', 0)) if r.get('最新价') not in (None, '-', '') else None,
            "change_pct": float(r.get('涨跌幅', 0)) if r.get('涨跌幅') not in (None, '-', '') else None,
            "change_amt": float(r.get('涨跌额', 0)) if r.get('涨跌额') not in (None, '-', '') else None,
            "high": float(r.get('最高', 0)) if r.get('最高') not in (None, '-', '') else None,
            "low": float(r.get('最低', 0)) if r.get('最低') not in (None, '-', '') else None,
            "open": float(r.get('今开', 0)) if r.get('今开') not in (None, '-', '') else None,
            "prev_close": float(r.get('昨收', 0)) if r.get('昨收') not in (None, '-', '') else None,
            "volume": float(r.get('成交量', 0)) if r.get('成交量') not in (None, '-', '') else None,
            "source": "akshare",
            "update_time": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
        }
    except Exception as e:
        return {"error": f"akshare_failed: {str(e)[:100]}"}

def query_yfinance(code):
    """yfinance 备源查询"""
    try:
        import yfinance as yf
        code = normalize_code(code)
        suffix = ".SS" if is_shanghai(code) else ".SZ"
        symbol = f"{code}{suffix}"
        ticker = yf.Ticker(symbol)
        # 取最近一日行情
        hist = ticker.history(period="1d")
        if hist.empty:
            return None
        row = hist.iloc[-1]
        prev_close = row.get("Close", 0)
        # 再试取前一日收盘作为昨收
        try:
            hist2 = ticker.history(period="2d")
            if len(hist2) >= 2:
                prev_close = float(hist2.iloc[-2]["Close"])
        except Exception:
            pass
        close_price = float(row.get("Close", 0))
        change_amt = close_price - prev_close if prev_close else 0
        change_pct = (change_amt / prev_close * 100) if prev_close else 0
        return {
            "code": code,
            "name": ticker.info.get("shortName", code) if hasattr(ticker, 'info') else code,
            "price": round(close_price, 2),
            "change_pct": round(change_pct, 2),
            "change_amt": round(change_amt, 2),
            "high": float(row.get("High", 0)) if row.get("High") else None,
            "low": float(row.get("Low", 0)) if row.get("Low") else None,
            "open": float(row.get("Open", 0)) if row.get("Open") else None,
            "prev_close": round(prev_close, 2),
            "source": "yfinance",
            "update_time": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
        }
    except Exception as e:
        return {"error": f"yfinance_failed: {str(e)[:100]}"}

def query_stock(code):
    """多源查询：akshare → yfinance → 缓存降级"""
    code = normalize_code(code)

    # 1. 先查缓存
    cached = read_cache(code)
    if cached and not cached.get("stale", True):
        return cached

    # 2. akshare 主源
    result = query_akshare(code)
    if result and "error" not in result and result.get("price") is not None:
        write_cache(code, result)
        return result

    # 3. yfinance 备源
    result = query_yfinance(code)
    if result and "error" not in result and result.get("price") is not None:
        write_cache(code, result)
        return result

    # 4. 缓存降级
    if cached and cached.get("price") is not None:
        cached["source"] = cached.get("source", "unknown") + "+stale"
        return cached

    # 5. 全部失败
    return {
        "code": code,
        "error": "all_sources_failed",
        "detail": f"akshare: {result.get('error', 'no_data') if result else 'failed'}",
    }

def format_text(data):
    """人类可读格式"""
    if "error" in data and "price" not in data:
        return f"❌ {data['code']}: 查询失败（{data.get('error', 'unknown')}）"

    name = data.get("name", data["code"])
    price = data.get("price", "N/A")
    pct = data.get("change_pct", 0) or 0
    amt = data.get("change_amt", 0) or 0
    sign = "📈" if pct >= 0 else "📉"
    stale = "（数据可能延迟）" if data.get("stale") or "+stale" in data.get("source", "") else ""
    src = data.get("source", "")

    return (
        f"{sign} {name}（{data['code']}）\n"
        f"  当前价：{price} 元\n"
        f"  涨跌幅：{pct:+.2f}%（{amt:+.2f}元）\n"
        f"  更新时间：{data.get('update_time', 'N/A')}\n"
        f"  数据来源：{src}{stale}"
    )

def main():
    if len(sys.argv) < 2:
        print("用法: python3 stock_price.py <股票代码> [股票代码2] ... [--api]")
        print("示例: python3 stock_price.py 300750")
        print("      python3 stock_price.py 300750 000001 --api")
        sys.exit(1)

    args = sys.argv[1:]
    api_mode = "--api" in args
    codes = [a for a in args if a != "--api"]

    results = []
    for code in codes:
        r = query_stock(code)
        results.append(r)

    if api_mode:
        if len(results) == 1:
            print(json.dumps(results[0], ensure_ascii=False, indent=2))
        else:
            print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print(format_text(r))
            print()

if __name__ == "__main__":
    main()
