// 手機核准的等待程式（0.63.51；0.63.53 安全審 A-3 改成向伺服器問）：外掛用 $.process.run 跑它（不吃 hook 的 10 秒預算）。
// 每 0.4 秒問本機伺服器 GET /approve-result（只回伺服器從 JWT 驗過的手機請求記下的決定），並看單（不是同一張 waiting 的單＝在電腦上結案了）；
// 不讀 decisions 檔（本機任何程序都能寫那個檔）。印「decided <json>」「settled」「timeout」「noserver」其中一個。獨立一支、不 import 任何東西，remote 的測試也能直接拿來跑
/**
 * 先確認監聽那個埠的是辦公室伺服器（remote/server.ts）：lsof 找監聽的 pid、ps 看指令列（安全審 (a)，0.63.54）。
 * 擋的是「別的程式先搶了這個埠假冒伺服器」；同帳號能任意執行程式的話仍可假冒（已知事項）。查不到（例如 Windows 沒有 lsof）一律當不是
 */
export const SERVER_CHECK_PY = [
  'import subprocess',
  'def ok_server(port):',
  '    try:',
  '        pids=subprocess.run(["/usr/sbin/lsof","-nP","-iTCP:%d"%port,"-sTCP:LISTEN","-t"],capture_output=True,text=True,timeout=2).stdout.split()',
  '        if len(pids)!=1: return False',
  '        cmd=subprocess.run(["/bin/ps","-o","command=","-p",pids[0]],capture_output=True,text=True,timeout=2).stdout',
  '        return "remote/server.ts" in cmd',
  '    except Exception: return False',
  // 本機金鑰（0.63.56 端點驗證）：伺服器的 /approve-result、/phone-live 要帶 X-PO-Key；讀不到就不帶（伺服器回 401，當成沒有）
  // F-3（0.63.56）：連本機伺服器不走 http_proxy 等代理（不然金鑰會跟著送到代理）
  'import urllib.request as _ur',
  'NOPROXY=_ur.build_opener(_ur.ProxyHandler({}))',
  'def key_headers(kf):',
  '    try:',
  '        with open(kf,encoding="utf-8") as f: return {"X-PO-Key": f.read().strip()}',
  '    except Exception: return {}',
].join('\n')
/** argv：問決定的網址、單的路徑、nonce、期限（毫秒）、本機金鑰檔；網址的埠先過 ok_server，不是辦公室伺服器就印 noserver */
export const WAITER_PY = SERVER_CHECK_PY + '\n' + [
  'import json,sys,time,urllib.request',
  'url,appr,nonce,deadline=sys.argv[1],sys.argv[2],sys.argv[3],float(sys.argv[4])/1000',
  'H=key_headers(sys.argv[5]) if len(sys.argv)>5 else {}',
  'import urllib.parse',
  'if not ok_server(urllib.parse.urlparse(url).port or 80): print("noserver"); sys.exit(0)',
  'def rd(p):',
  '    try:',
  '        with open(p,encoding="utf-8") as f: return json.load(f)',
  '    except FileNotFoundError: return {}',
  '    except Exception: return None',
  'def ask():',
  '    try:',
  '        with NOPROXY.open(urllib.request.Request(url,headers=H),timeout=1.5) as r: return json.loads(r.read().decode("utf-8"))',
  '    except Exception: return None',
  'while time.time()<deadline:',
  '    d=ask()',
  '    if isinstance(d,dict) and d.get("state")=="decided" and d.get("nonce")==nonce: print("decided "+json.dumps(d)); sys.exit(0)',
  '    a=rd(appr)',
  '    if a is not None and (a.get("state")!="waiting" or a.get("nonce")!=nonce): print("settled"); sys.exit(0)',
  '    time.sleep(0.4)',
  'print("timeout")',
].join('\n')
/** 問手機有沒有在看（GET /phone-live）：同樣先確認是辦公室伺服器；argv：網址、本機金鑰檔 */
export const PHONE_LIVE_PY = SERVER_CHECK_PY + '\n' + [
  'import sys,urllib.request,urllib.parse',
  'url=sys.argv[1]',
  'if ok_server(urllib.parse.urlparse(url).port or 80):',
  '    try: print(NOPROXY.open(urllib.request.Request(url,headers=key_headers(sys.argv[2]) if len(sys.argv)>2 else {}),timeout=1.5).read().decode("utf-8"))',
  '    except Exception: pass',
].join('\n')

/** 等待端採用決定時附加一筆到 approve-log.jsonl（R7 留證據，2026-11-26）：O_APPEND＋0600；argv[1]＝檔案，argv[2]＝一行 JSON */
export const APPROVE_LOG_PY = 'import os,sys\nfd=os.open(sys.argv[1],os.O_WRONLY|os.O_APPEND|os.O_CREAT,0o600)\ntry: os.write(fd,(sys.argv[2]+"\\n").encode("utf-8"))\nfinally: os.close(fd)'
