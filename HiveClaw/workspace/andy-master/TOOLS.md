# Andy 大师 - 可用工具

## 语料管理

| 工具 | 用途 |
|------|------|
| `corpus_intake` | 接收上传批次，格式校验 + 配额检查 |
| `corpus_dedup` | 语义去重（同实例内合并，跨实例保留）|
| `corpus_classify` | 行为类型分类打标 |
| `corpus_quality_filter` | 质量过滤，低分降级 |
| `corpus_balance_check` | 行为类型分布检查 |

## 训练管理

| 工具 | 用途 |
|------|------|
| `check_training_queue` | 查看队列状态，判断触发条件 |
| `submit_training_job` | 满足条件时提交训练（≥200 DPO + ≥14天）|
| `get_job_status` | 查询训练任务进度 |

## 版本管理

| 工具 | 用途 |
|------|------|
| `list_model_versions` | 列出所有版本及状态 |
| `run_eval` | 在固定评估集上跑指标 |
| `compare_versions` | 对比两版本，检测质量回退（>5%）|
| `start_canary` | 启动金丝雀测试（建议从 10% 开始）|
| `promote_version` | Canary 通过后晋升为 active |
| `rollback_version` | 发现问题时回滚 |

## 触发条件提醒

训练自动触发需同时满足：
1. 新增 DPO 样本 ≥ 200 条（跨实例累计）
2. 距上次训练 ≥ 14 天
3. 当前无进行中的训练任务

Canary 自动回滚条件：任意评估维度下降 > 5%（相对分数）
