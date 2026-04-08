"""
测试：从移动端分享页 _ROUTER_DATA 提取抖音视频下载链接
参考：搜索结果中提到"不需要 Cookie，不需要登录"
"""
import asyncio, json, re
import aiohttp

VIDEO_ID = '7615159574219279642'

MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TikTok/26.2.0 iPhone13,3'

async def try_router_data():
    url = f'https://www.iesdouyin.com/share/video/{VIDEO_ID}/'
    headers = {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://www.douyin.com/',
    }
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, allow_redirects=True) as resp:
            print(f'URL: {resp.url}')
            print(f'状态: {resp.status}  长度: {resp.headers.get("content-length","?")}')
            html = await resp.text()
            print(f'HTML 长度: {len(html)}')

            # 找 _ROUTER_DATA
            m = re.search(r'_ROUTER_DATA\s*=\s*(\{.+?\});\s*</script>', html, re.S)
            if m:
                print('\n找到 _ROUTER_DATA！前300字:')
                print(m.group(1)[:300])
            else:
                print('\n未找到 _ROUTER_DATA，HTML 前500字:')
                print(html[:500])

            # 找 desc
            desc = re.search(r'"desc"\s*:\s*"([^"]{5,200})"', html)
            if desc:
                print('\n✅ 找到 desc:', desc.group(1))

            # 找 nickname
            nick = re.search(r'"nickname"\s*:\s*"([^"]{1,50})"', html)
            if nick:
                print('✅ 找到 nickname:', nick.group(1))

asyncio.run(try_router_data())
