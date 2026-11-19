import asyncio, sys
from playwright.async_api import async_playwright
BASE=sys.argv[1]; OUT=sys.argv[2]
async def main():
    async with async_playwright() as p:
        br=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        pg=await br.new_page(viewport={'width':1500,'height':900}); errs=[]
        pg.on('pageerror',lambda e:errs.append(str(e)))
        await pg.goto(BASE); await pg.wait_for_function("window.__gf && window.__gf.FishSprite")
        await pg.evaluate("""()=>{const FS=window.__gf.FishSprite;document.body.innerHTML='';document.body.style.cssText='margin:0;background:#1456a0;font:13px monospace;color:#fff';
          const cols=[['straight E',0,0,0],['wag 1',0,0,1],['wag 3',0,0,3],['gentle curve',0,1,1],['sharp turn (flank)',0,2,1],['sharp turn other way',0,-2,3],['heading SE, curve',2,-1,1],['heading N',12,0,2],['heading SW dart',6,2,0]];
          const types=[['s','small 1pt'],['b','big 3pt'],['g','golden 5pt'],['k','black moor 5pt']];
          const wrap=document.createElement('div');wrap.style.cssText='display:grid;grid-template-columns:90px repeat(9,150px);gap:4px;padding:6px;align-items:center;justify-items:center';
          wrap.appendChild(document.createElement('div'));cols.forEach(c=>{const d=document.createElement('div');d.textContent=c[0];d.style.cssText='font-size:11px;text-align:center';wrap.appendChild(d)});
          types.forEach(t=>{const l=document.createElement('div');l.textContent=t[1];wrap.appendChild(l);
            cols.forEach(c=>{const e=FS.get(t[0],c[1]/16*Math.PI*2,c[2],c[3],1);const cv=document.createElement('canvas');cv.width=cv.height=e.R*2;
              cv.style.cssText='width:'+(e.R*2*3.4)+'px;height:'+(e.R*2*3.4)+'px;image-rendering:pixelated;background:#1b6ab8';
              const g=cv.getContext('2d');g.drawImage(e.sh,2,3);g.drawImage(e.c,0,0);wrap.appendChild(cv)})});
          document.body.appendChild(wrap)}""")
        await pg.screenshot(path=OUT); print(errs); await br.close()
asyncio.run(main())
