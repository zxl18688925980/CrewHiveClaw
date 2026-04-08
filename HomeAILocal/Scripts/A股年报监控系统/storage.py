#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
存储模块 - SQLite 数据存储与去重
"""

import os
import sqlite3
import datetime
from typing import Optional, List, Dict, Any

import config


def init_db():
    """初始化数据库，创建表结构"""
    os.makedirs(config.STORAGE_PATH, exist_ok=True)
    
    conn = sqlite3.connect(config.DB_PATH)
    cursor = conn.cursor()
    
    # 股票年报数据表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS stock_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stock_code TEXT NOT NULL,
            stock_name TEXT,
            report_year INTEGER,
            disclosure_date TEXT,
            forecast_type TEXT,
            forecast_value TEXT,
            actual_value TEXT,
            audit_opinion TEXT,
            source_url TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE(stock_code, report_year)
        )
    """)
    
    # 已推送记录表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sent_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stock_code TEXT NOT NULL,
            anomaly_type TEXT NOT NULL,
            anomaly_detail TEXT,
            sent_at TEXT NOT NULL
        )
    """)
    
    conn.commit()
    conn.close()
    print(f"数据库初始化完成: {config.DB_PATH}")


def get_previous_report(stock_code: str, report_year: int) -> Optional[Dict[str, Any]]:
    """获取某股票某年的上一次记录"""
    conn = sqlite3.connect(config.DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT disclosure_date, forecast_type, forecast_value, 
               actual_value, audit_opinion
        FROM stock_reports
        WHERE stock_code = ? AND report_year = ?
        ORDER BY updated_at DESC
        LIMIT 1
    """, (stock_code, report_year))
    
    row = cursor.fetchone()
    conn.close()
    
    if row:
        return {
            "disclosure_date": row[0],
            "forecast_type": row[1],
            "forecast_value": row[2],
            "actual_value": row[3],
            "audit_opinion": row[4],
        }
    return None


def save_report(stock_code: str, report_data: Dict[str, Any]):
    """保存股票年报数据"""
    conn = sqlite3.connect(config.DB_PATH)
    cursor = conn.cursor()
    
    now = datetime.datetime.now().isoformat()
    
    cursor.execute("""
        INSERT OR REPLACE INTO stock_reports 
        (stock_code, stock_name, report_year, disclosure_date, 
         forecast_type, forecast_value, actual_value, audit_opinion, 
         source_url, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        stock_code,
        report_data.get("stock_name"),
        report_data.get("report_year"),
        report_data.get("disclosure_date"),
        report_data.get("forecast_type"),
        report_data.get("forecast_value"),
        report_data.get("actual_value"),
        report_data.get("audit_opinion"),
        report_data.get("source_url"),
        now,
    ))
    
    conn.commit()
    conn.close()


def is_already_reported(stock_code: str, anomaly_type: str) -> bool:
    """检查某异常是否在去重时间窗口内已推送"""
    conn = sqlite3.connect(config.DB_PATH)
    cursor = conn.cursor()
    
    threshold = datetime.datetime.now() - datetime.timedelta(
        hours=config.THRESHOLDS["dedup_hours"]
    )
    
    cursor.execute("""
        SELECT COUNT(*) FROM sent_records
        WHERE stock_code = ? 
          AND anomaly_type = ?
          AND sent_at > ?
    """, (stock_code, anomaly_type, threshold.isoformat()))
    
    count = cursor.fetchone()[0]
    conn.close()
    
    return count > 0


def mark_as_reported(stock_code: str, anomaly_type: str, detail: str = ""):
    """标记异常已推送"""
    conn = sqlite3.connect(config.DB_PATH)
    cursor = conn.cursor()
    
    now = datetime.datetime.now().isoformat()
    
    cursor.execute("""
        INSERT INTO sent_records (stock_code, anomaly_type, anomaly_detail, sent_at)
        VALUES (?, ?, ?, ?)
    """, (stock_code, anomaly_type, detail, now))
    
    conn.commit()
    conn.close()


if __name__ == "__main__":
    # 测试初始化
    init_db()
    print("存储模块测试完成")
