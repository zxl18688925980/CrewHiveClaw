#!/usr/bin/env python3
"""
系统时间查询脚本
用途：测试流水线是否正常工作
输出：打印当前时间到 stdout + 追加写入 app/generated/sys-time.txt
"""

from datetime import datetime

if __name__ == "__main__":
    now = datetime.now()
    formatted = now.strftime("%Y-%m-%d %H:%M:%S")
    print(formatted)
    
    # 追加写入 app/generated/sys-time.txt
    output_path = "/Users/xinbinanshan/HomeAI/app/generated/sys-time.txt"
    with open(output_path, "a") as f:
        f.write(formatted + "\n")
