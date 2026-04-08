#!/usr/bin/env python3
"""
曾璿岐霖升级脚本
使用真实的家庭信息重新微调 homeai-assistant 模型
"""

import os
import json
import subprocess

# 读取家庭信息
HOME_DIR = os.path.expanduser("~/.homeai")
FAMILY_INFO_FILE = os.path.join(HOME_DIR, "family-info.json")

def load_family_info():
    """加载家庭信息"""
    with open(FAMILY_INFO_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def create_zenghuanqilin_modelfile():
    """创建曾璿岐霖的 Modelfile"""
    info = load_family_info()
    
    # 构建系统提示
    system_prompt = f"""你是{info['aiName']}，{info['aiRole']}。

你的身份：
- 名字：{info['aiName']}
- 角色：{info['aiRole']}
- 性格：{info['preferences']}

你的家庭：
- 爸爸：{info['notes'].split('爸爸 ')[1].split(' 妈妈')[0] if '爸爸' in info['notes'] else '爸爸'}
- 妈妈：{info['notes'].split('妈妈 ')[1].split(' 小姨')[0] if '妈妈' in info['notes'] else '妈妈'}
- 小姨：{info['notes'].split('小姨 ')[1].split(' 姐姐')[0] if '小姨' in info['notes'] else '小姨'}
- 姐姐：{info['notes'].split('姐姐 ')[1].split(' 逸翠园')[0] if '姐姐' in info['notes'] else '姐姐'}

你的能力：
1. 对话交互 - 与家人自然交流
2. 意图识别 - 理解家人的需求
3. 任务编排 - 协调 Andy (架构师) 和 Lisa (工程师) 完成开发任务
4. 长记忆 - 记住家人的偏好和习惯
5. 设备管理 - 管理家庭智能设备（如：{info['devices']}）

对话风格：
- {info['preferences']}
- 友好、亲切
- 简洁明了
- 主动提供帮助

当家人提出开发需求时，你应该：
- 分析需求复杂度
- 简单问题直接回答
- 复杂问题调用 Andy 进行设计，调用 Lisa 进行实现

记住：你是{info['aiName']}，正在成长为曾家的贾维斯！"""
    
    # 创建 Modelfile
    modelfile_content = f"""FROM qwen2.5:7b

# 系统提示词 - {info['aiName']} 身份
SYSTEM \"\"\"{system_prompt}\"\"\"

# 模板格式
TEMPLATE \"\"\"{{{{- if .System }}}}{{{{ .System }}}}{{{{ end }}}}
{{{{- range $i, $_ := .Messages }}}}
{{{{- $last := eq (len (slice $.Messages $i)) 1}}}}
{{{{- if eq .Role \"user\" }}}}<｜User｜>{{{{ .Content }}}}
{{{{- else if eq .Role \"assistant\" }}}}<｜Assistant｜>
  {{{{ if and $.IsThinkSet (and $last .Thinking) -}}}}
<think>
{{{{ .Thinking }}}}
</think>
{{{{- end }}}}{{{{ .Content }}}}{{{{ if not $last }}}}<｜end▁of▁sentence｜>{{{{- end }}}}
{{{{- end }}}}
{{{{- if and $last (ne .Role \"assistant\") }}}}<｜Assistant｜>
{{{{- if and $.IsThinkSet (not $.Think) -}}}}
<think>

</think>

{{{{ end }}}}
{{{{- end -}}}}
{{{{- end }}}}\"\"\"

PARAMETER stop <｜begin▁of▁sentence｜>
PARAMETER stop <｜end▁of▁sentence｜>
PARAMETER stop <｜User｜>
PARAMETER stop <｜Assistant｜>"""
    
    # 保存 Modelfile
    models_dir = os.path.expanduser("~/HomeAI/Models")
    os.makedirs(models_dir, exist_ok=True)
    
    modelfile_path = os.path.join(models_dir, "Modelfile.zenghuanqilin")
    with open(modelfile_path, 'w', encoding='utf-8') as f:
        f.write(modelfile_content)
    
    print(f"✅ Modelfile 已保存到: {modelfile_path}")
    return modelfile_path

def run_finetune():
    """执行微调"""
    print("🚀 开始升级曾璿岐霖...")
    
    # 1. 创建新的 Modelfile
    modelfile_path = create_zenghuanqilin_modelfile()
    
    # 2. 删除旧的 homeai-assistant 模型（如果存在）
    print("🔄 检查现有模型...")
    result = subprocess.run(["ollama", "list"], capture_output=True, text=True)
    if "homeai-assistant" in result.stdout:
        print("🗑️  删除旧的 homeai-assistant 模型...")
        subprocess.run(["ollama", "rm", "homeai-assistant"], capture_output=True)
    
    # 3. 创建新的模型
    print("🔧 创建新的 homeai-assistant 模型...")
    result = subprocess.run(
        ["ollama", "create", "homeai-assistant", "-f", modelfile_path],
        capture_output=True,
        text=True
    )
    
    if result.returncode == 0:
        print("🎉 曾璿岐霖升级成功！")
        print(f"📝 输出: {result.stdout}")
        
        # 4. 验证模型
        print("\n🔍 验证新模型...")
        verify_model()
        
        return True
    else:
        print("❌ 升级失败")
        print(f"📝 错误: {result.stderr}")
        return False

def verify_model():
    """验证模型是否包含正确的身份"""
    print("\n🧪 测试模型身份...")
    
    test_prompt = "你是谁？请介绍一下你自己和你的家庭。"
    
    result = subprocess.run(
        ["ollama", "run", "homeai-assistant", test_prompt],
        capture_output=True,
        text=True,
        timeout=30
    )
    
    if result.returncode == 0:
        response = result.stdout
        print("📝 模型响应:")
        print("-" * 50)
        print(response[:500])  # 只显示前500字符
        print("-" * 50)
        
        # 检查是否包含关键信息
        check_keywords = ["曾璿岐霖", "曾家", "小儿子", "爸爸", "妈妈", "小姨", "姐姐"]
        found_keywords = [kw for kw in check_keywords if kw in response]
        
        if len(found_keywords) >= 3:
            print(f"✅ 模型包含家庭信息: {', '.join(found_keywords)}")
        else:
            print("⚠️  模型可能未正确包含家庭信息")
    else:
        print("❌ 模型测试失败")

def main():
    print("=" * 60)
    print("         曾璿岐霖升级计划")
    print("          从'小龙'升级为'曾家小儿子贾维斯'")
    print("=" * 60)
    
    # 显示当前家庭信息
    info = load_family_info()
    print("\n📋 家庭信息:")
    print(f"  AI 名字: {info['aiName']}")
    print(f"  AI 角色: {info['aiRole']}")
    print(f"  性格: {info['preferences']}")
    print(f"  家庭成员: {info['familyMembers']}")
    print(f"  地点: {info['location']}")
    
    # 执行升级
    success = run_finetune()
    
    if success:
        print("\n" + "=" * 60)
        print("🎊 升级完成！")
        print("曾璿岐霖已成功回归！")
        print("=" * 60)
        print("\n下一步:")
        print("1. 重启 HomeAI 守护进程以使用新模型")
        print("2. 测试对话确认身份认知")
        print("3. 享受真正的曾家小儿子贾维斯服务！")
    else:
        print("\n❌ 升级失败，请检查错误信息")

if __name__ == "__main__":
    main()