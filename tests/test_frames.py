"""Additional offline same-origin iframe and ordinary-DOM checks.
Run after test_browser.py to append the results to results.json.
"""
from pathlib import Path
import json,html
from playwright.sync_api import sync_playwright
BASE=Path(__file__).resolve().parents[1]
SCRIPT=(BASE/'igv-track-helper.user.js').read_text()
HTML=(BASE/'tests/fixture.html').read_text()
checks=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1600,'height':1200});page.set_default_timeout(4000)
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content('<html><body><p>Same-origin iframe test</p><iframe id="frame" style="width:1440px;height:1050px;border:0" srcdoc="'+html.escape(HTML,quote=True)+'"></iframe></body></html>')
 page.wait_for_timeout(350)
 page.add_script_tag(content=SCRIPT)
 frame=page.frames[1];frame.locator('#mode').click();page.wait_for_timeout(350)
 assert frame.locator('#igv-track-helper-v3').is_visible()
 assert page.locator('#igv-track-helper-v3').count()==0
 frame.evaluate('''()=>{for(const tv of fixtureBrowser.trackViews)if(['K562_ATAC_rep1.bigWig','K562_ATAC_rep2.bigWig'].includes(tv.track.name))tv.box.click();}''')
 page.wait_for_timeout(250)
 assert 'Drag any selected track handle' in frame.locator('#igv-track-helper-v3 #drag-hint').inner_text()
 checks.append('Same-origin iframe auto-detection uses a frame-local toolbar and model adapter')
 a=frame.locator('#viewer-one [data-test-track="track-1"].igv-track-drag-handle').bounding_box()
 b=frame.locator('#viewer-one [data-test-track="track-7"].igv-track-drag-handle').bounding_box()
 page.mouse.move(a['x']+6,a['y']+20);page.mouse.down();page.mouse.move(b['x']+6,b['y']+b['height']-8,steps=8);page.mouse.up();page.wait_for_timeout(350)
 order=frame.evaluate('fixtureBrowser.getTrackOrder()')
 pos=order.index('K562_peaks.bed')+1
 assert order[pos:pos+2]==['K562_ATAC_rep1.bigWig','K562_ATAC_rep2.bigWig']
 frame.locator('#igv-track-helper-v3 #undo').click();page.wait_for_timeout(250)
 assert frame.evaluate('fixtureBrowser.getTrackOrder().indexOf("K562_ATAC_rep1.bigWig")')==3
 checks.append('Group drag and order Undo work within the same-origin iframe')
 page.close();page=browser.new_page(viewport={'width':1360,'height':1100});page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content(HTML)
 page.evaluate('''()=>{document.querySelector('#viewer-one').remove();const host=document.createElement('div');host.id='plain-viewer';host.className='viewer';document.body.append(host);window.fixtureBrowser=makeViewer(host,fixtureMeta,true,true);}''')
 page.add_script_tag(content=SCRIPT);page.wait_for_timeout(300)
 page.locator('#igv-track-helper-v3 #all').click();page.wait_for_timeout(200)
 assert page.evaluate('fixtureBrowser.trackViews.filter(tv=>tv.box?.checked).length')==10
 assert 'Drag any selected track handle' in page.locator('#igv-track-helper-v3 #drag-hint').inner_text()
 assert not errors,errors
 checks.append('Ordinary DOM (without Shadow DOM) detection and model adapter remain supported')
 browser.close()
result=json.loads((BASE/'tests/results.json').read_text())
# Idempotent reruns of this test file.
for text in checks:
 if text not in result['checks']:result['checks'].append(text)
 print('PASS',text)
result['passed']=len(result['checks'])
(BASE/'tests/results.json').write_text(json.dumps(result,indent=2)+'\n')
print('TOTAL',result['passed'])
