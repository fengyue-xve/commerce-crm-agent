"""Own the isolated local demo process; never starts or stops the full CRM."""
import json,os,socket,subprocess,sys,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
RUNTIME=ROOT/'output/portfolio'
STATE=RUNTIME/'process.json'
HIDDEN=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0

def fingerprint(pid):
    try:
        if os.name=='nt':
            return subprocess.check_output(['powershell','-NoProfile','-Command',f'(Get-Process -Id {int(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks'],creationflags=HIDDEN,stderr=subprocess.DEVNULL,text=True).strip()
        stat=Path(f'/proc/{pid}/stat')
        return stat.read_text().split(')',1)[1].split()[19] if stat.exists() else subprocess.check_output(['ps','-p',str(pid),'-o','lstart='],text=True).strip()
    except (OSError,subprocess.CalledProcessError):return None

def stop():
    if not STATE.exists():print('No recorded demo process.');return
    state=json.loads(STATE.read_text(encoding='utf-8'))
    current=fingerprint(state['pid'])
    if current and current==state['fingerprint']:
        if os.name=='nt':subprocess.run(['taskkill','/PID',str(state['pid']),'/T','/F'],check=True,creationflags=HIDDEN,stdout=subprocess.DEVNULL)
        else:
            import signal
            os.kill(state['pid'],signal.SIGTERM)
        print('Stopped isolated fulfillment demo.')
    elif current:raise RuntimeError('Process id reused; no action taken')
    STATE.unlink(missing_ok=True)

def start():
    import shutil
    if not (ROOT/'node_modules/tsx/dist/cli.mjs').exists():raise RuntimeError('Run corepack pnpm install --frozen-lockfile first')
    with socket.socket() as sock:
        if sock.connect_ex(('127.0.0.1',15273))==0:raise RuntimeError('Port 15273 occupied; no process started')
    RUNTIME.mkdir(parents=True,exist_ok=True)
    with (RUNTIME/'server.log').open('wb') as log:
        proc=subprocess.Popen([shutil.which('node') or 'node','node_modules/tsx/dist/cli.mjs','scripts/portfolio/server.mts'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=HIDDEN)
    identity=fingerprint(proc.pid)
    if not identity:raise RuntimeError('Could not record process identity')
    STATE.write_text(json.dumps({'pid':proc.pid,'fingerprint':identity}),encoding='utf-8')
    try:
        for _ in range(100):
            if proc.poll() is not None:raise RuntimeError('Demo exited; inspect output/portfolio/server.log')
            try:
                with urllib.request.urlopen('http://127.0.0.1:15273/api/health',timeout=1) as response:
                    if response.status==200:print('Ready: http://127.0.0.1:15273 (scripted Pi Faux; no customer sending)');return
            except OSError:pass
            time.sleep(.2)
        raise RuntimeError('Demo readiness timed out')
    except Exception:stop();raise

if __name__=='__main__':
    command=sys.argv[1] if len(sys.argv)>1 else ''
    if command not in {'start','stop'}:raise SystemExit('Usage: python scripts/portfolio/demo.py start|stop')
    {'start':start,'stop':stop}[command]()
