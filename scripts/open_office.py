"""用這台電腦的瀏覽器開辦公室（0.64.1）：帶本機金鑰要一條一次性登入連結，用預設瀏覽器打開；登入後瀏覽器直接開 127.0.0.1:<埠> 就行，伺服器重開才要再跑一次。

  python open_office.py            # 8767
  python open_office.py --port 8768
  python open_office.py --print    # 只印連結（60 秒內、只能用一次），不開瀏覽器
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import webbrowser

sys.stdout.reconfigure(encoding='utf-8')


def main() -> int:
    ap = argparse.ArgumentParser(description='Open the office in this computer\'s browser (one-time login link).')
    ap.add_argument('--port', type=int, default=8767)
    ap.add_argument('--print', action='store_true', help='print the link instead of opening a browser')
    a = ap.parse_args()
    key_file = os.path.expanduser('~/.claude/pixel-office/local-key')
    try:
        key = open(key_file, encoding='utf-8').read().strip()
    except OSError:
        print(f'讀不到本機金鑰 {key_file}：辦公室伺服器還沒啟動過？先開伺服器再跑')
        return 1
    req = urllib.request.Request(f'http://127.0.0.1:{a.port}/login-link', data=b'{}', headers={'X-PO-Key': key, 'content-type': 'application/json'})
    try:
        r = json.loads(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=5).read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        print(f'伺服器回 {e.code}：{e.read().decode("utf-8", "replace")}（這一版的伺服器還沒有本機瀏覽器登入？重開伺服器試試）')
        return 1
    except OSError as e:
        print(f'連不上 127.0.0.1:{a.port}（{e}）：辦公室伺服器有在跑嗎？')
        return 1
    url = r.get('url')
    if not url:
        print(f'伺服器沒給連結：{r}')
        return 1
    if a.print or not webbrowser.open(url):
        print(url)
    else:
        print(f'已用瀏覽器開 127.0.0.1:{a.port}（之後直接開這個網址就行，伺服器重開才要再跑）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
