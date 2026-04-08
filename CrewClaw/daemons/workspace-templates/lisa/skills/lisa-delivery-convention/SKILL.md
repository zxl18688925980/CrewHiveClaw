---
name: lisa-delivery-convention
description: 代码交付标准：脚本能直接运行、错误信息是人话、有执行回显、生成文件名含时间戳、推送后有确认。
---

# Skill：交付约定——Lisa 的代码输出标准

**名称**：交付约定——让家人能直接用的代码长什么样

**适用角色**：Lisa

**类型**：通用最佳实践

---

## 这个 Skill 在什么时候用

每次写完脚本，用这里的标准检查一遍再交付。

---

## 正确的做法是什么

**交付物检查清单**：

**1. 脚本能直接运行**
- 不依赖外部未安装的包（或者在脚本头部注明安装命令）
- 直接 `python3 <script>.py` 跑起来不报错
- 首次运行会自动创建需要的目录（`os.makedirs(..., exist_ok=True)`）

**2. 错误信息是人话**
```python
# 好
try:
    result = call_api()
except Exception as e:
    print(f"调用失败了，原因：{e}。检查一下 .env 里的 API key 是否还有效。")
    exit(1)

# 不好
raise Exception(e)  # 直接抛出，家人看不懂
```

**3. 执行结果有回显**
```python
print("正在读取作业文件...")
print(f"找到 {len(files)} 份作业")
print("报告生成完成，已发送给妈妈。")
```

**4. 生成文件名有时间戳**
```python
timestamp = datetime.datetime.now().strftime('%Y-%m-%dT%H-%M-%S')
filename = f"wrong-questions-{timestamp}.docx"
```

**5. 推送完成后确认**
```python
result = push_to_wecom(user_id, content)
if result.get('errcode') == 0:
    print("已发送给妈妈 ✓")
else:
    print(f"发送失败：{result.get('errmsg')}")
```

**不应该做什么**：
- 不要只写函数不写主函数（要有 `if __name__ == '__main__':` 入口）
- 不要让脚本静默运行完全没有输出
- 不要用 `sys.exit(0)` 之外的方式退出（会让 crontab 拿到奇怪的返回码）

---

## 例子

**完整的脚本结构**：
```python
#!/usr/bin/python3
"""
wrong_questions_report.py
生成错题报告并推送给妈妈
"""
import os
import datetime
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../../../.env'))

def generate_report():
    print("开始生成错题报告...")
    # ... 业务逻辑
    print("报告生成完成。")
    return output_path

def send_report(path):
    print(f"正在发送：{path}")
    # ... 推送逻辑
    print("发送成功 ✓")

if __name__ == '__main__':
    try:
        path = generate_report()
        send_report(path)
    except Exception as e:
        print(f"出错了：{e}")
        exit(1)
```

---

## 备注

- 脚本放到 `~/HomeAI/Family/` 或 `~/HomeAI/scripts/` 下，视功能归属
- 定时任务由 crontab 管理，Lisa 只负责写脚本，岐霖配置 crontab
- 每次交付后，Lisa 在回复里说明"怎么运行"和"运行结果长什么样"
