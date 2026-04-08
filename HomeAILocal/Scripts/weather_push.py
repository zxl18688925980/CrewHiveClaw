#!/usr/bin/python3
"""
weather_push.py
每天早上推送深圳天气到企业微信
"""
import os
import sys
import requests
from dotenv import load_dotenv

# 加载环境变量
load_dotenv(os.path.join(os.path.dirname(__file__), '../.env'))

# 配置
WECOM_OWNER_ID = os.getenv('WECOM_OWNER_ID', 'ZengXiaoLong')
WECOM_ENTRANCE_URL = 'http://localhost:3003/send'
WEATHER_API_URL = 'https://wttr.in/Shenzhen?format=j1&lang=zh'


def fetch_weather():
    """获取深圳天气数据"""
    try:
        print("正在获取深圳天气数据...")
        resp = requests.get(WEATHER_API_URL, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        
        # 提取关键信息
        current = data['current_condition'][0]
        today = data['weather'][0]
        
        # 当前天气
        temp = current['temp_C']
        feels_like = current['FeelsLikeC']
        humidity = current['humidity']
        wind = current['windspeedKmph']
        description = current['lang_zh'][0]['value'] if 'lang_zh' in current else current['weatherDesc'][0]['value']
        
        # 今日温度范围
        max_temp = today['maxtempC']
        min_temp = today['mintempC']
        
        # 降水概率
        hourly_rain = []
        for hour in today['hourly']:
            hourly_rain.append(int(hour['chanceofrain']))
        max_rain_chance = max(hourly_rain) if hourly_rain else 0
        
        # 日出日落
        sunrise = today['astronomy'][0]['sunrise']
        sunset = today['astronomy'][0]['sunset']
        
        # 组装消息
        message = f"""🌤️ 深圳今日天气

当前：{description}
温度：{temp}°C（体感 {feels_like}°C）
湿度：{humidity}%
风速：{wind} km/h

今日：{min_temp}°C ~ {max_temp}°C
降水概率：最高 {max_rain_chance}%

日出：{sunrise}
日落：{sunset}

祝您今天愉快！"""
        
        print(f"天气数据获取成功：{description}，{temp}°C")
        return message
        
    except requests.exceptions.Timeout:
        print("获取天气数据超时，请检查网络连接。")
        return None
    except requests.exceptions.RequestException as e:
        print(f"获取天气数据失败：{e}")
        return None
    except (KeyError, IndexError) as e:
        print(f"解析天气数据失败：{e}")
        return None


def push_to_wecom(user_id, content):
    """推送到企业微信"""
    try:
        print(f"正在推送给 {user_id}...")
        resp = requests.post(WECOM_ENTRANCE_URL, json={
            'touser': user_id,
            'msgtype': 'text',
            'text': {'content': content}
        }, timeout=10)
        
        result = resp.json()
        
        if result.get('errcode') == 0:
            print("推送成功 ✓")
            return True
        else:
            print(f"推送失败：{result.get('errmsg', '未知错误')}")
            return False
            
    except requests.exceptions.RequestException as e:
        print(f"连接企业微信推送服务失败：{e}")
        print("请确认 wecom-entrance 服务是否在运行（http://localhost:3003）")
        return False


def main():
    """主函数"""
    print("=" * 50)
    print("天气播报开始")
    print("=" * 50)
    
    # 获取天气
    weather_message = fetch_weather()
    if not weather_message:
        print("天气获取失败，终止推送。")
        sys.exit(1)
    
    print("-" * 50)
    
    # 推送消息
    success = push_to_wecom(WECOM_OWNER_ID, weather_message)
    
    print("=" * 50)
    if success:
        print("天气播报完成")
        sys.exit(0)
    else:
        print("天气播报失败")
        sys.exit(1)


if __name__ == '__main__':
    main()
