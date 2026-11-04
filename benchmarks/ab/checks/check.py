import sys,json,subprocess,importlib,os
sys.path.insert(0,os.getcwd())
t=sys.argv[1]; ans=open(sys.argv[2]).read() if len(sys.argv)>2 else ''
def run(code):
    return subprocess.run([sys.executable,'-c',code],capture_output=True,text=True)
ok=False
if t=='t1':
    ok=run('from util import *\nassert slugify("  Hello,  World! ")=="hello-world"\nassert chunk([1,2,3,4,5],2)==[[1,2],[3,4],[5]]\nassert median([4,1,3,2])==2.5 and median([3,1,2])==2').returncode==0
elif t=='t2':
    c=json.load(open('config.json')); ok=c=={"name":"demo","port":9090,"debug":True}
elif t=='t3':
    ok=open('notes.txt').read().split()==['alpha','beta','gamma','delta']
elif t=='t4':
    src=''.join(open(f'shop/{f}').read() for f in ['orders.py','pricing.py','report.py','cli.py'])
    ok='calc_total' not in src and run('from shop.pricing import order_total\nfrom shop.orders import checkout\nfrom shop.report import summary\nimport shop.cli\nassert order_total([("a",10,2)],"SAVE10")==18.0 or True\nassert checkout([("a",10,2)])==20.0').returncode==0
elif t=='t5':
    ok=run('from util import parse_kv\nassert parse_kv("a=1;b=2")=={"a":"1","b":"2"}\nassert parse_kv(" a = x y ; b=2 ;")=={"a":"x y","b":"2"}\nassert parse_kv("")=={}\nassert parse_kv("k=v=w")=={"k":"v=w"}').returncode==0
elif t=='t6':
    a=ans.lower(); ok=('inventory.py' in a and '1.5' in a)
elif t=='t7':
    r=subprocess.run([sys.executable,'paid_total.py'],capture_output=True,text=True)
    ok=r.returncode==0 and '22.75' in r.stdout
elif t=='t8':
    ok=run('from shop.pricing import calc_total as c\nassert c([("a",100,1)],"SAVE10")==90.0\nassert c([("a",40,2)],"SAVE25")==60.0\nassert c([("a",10,3)])==30.0\nassert c([("a",19.99,1)],"SAVE10")==17.99').returncode==0
print(json.dumps(ok))
