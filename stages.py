import asyncio, sys
from playwright.async_api import async_playwright
BASE=sys.argv[1]; OUT=sys.argv[2]
async def main():
    async with async_playwright() as p:
        br=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        pg=await br.new_page(viewport={'width':1100,'height':330}); errs=[]
        pg.on('pageerror',lambda e:errs.append(str(e)))
        await pg.goto(BASE+'play.html?r=STAGES'); await pg.wait_for_function("window.NetSprite")
        await pg.evaluate("""()=>{document.body.innerHTML='';document.body.style.cssText='margin:0;background:#0b2a5b;font:14px monospace;color:#fff';
          const row=(label,down,col,top)=>{const d=document.createElement('div');d.style.cssText='position:absolute;left:10px;top:'+top+'px;display:flex;gap:6px';
            for(let s=0;s<=5;s++){const c=document.createElement('canvas');c.width=c.height=40;c.style.cssText='width:160px;height:160px;image-rendering:pixelated;background:'+(down?'#2d86d6':'#1b6ab8');
              c.getContext('2d').drawImage(NetSprite.get(s,col,down),0,0);d.appendChild(c)}document.body.appendChild(d)};
          row('up',false,'#ff4f8b',0);row('down',true,'#b6f23a',165)}""")
        await pg.screenshot(path=OUT); print(errs); await br.close()
asyncio.run(main())
