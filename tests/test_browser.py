"""Offline Chromium integration checks against a native-shaped IGV test double.
Run: python tests/test_browser.py (requires playwright and /usr/bin/chromium).
No KU Leuven login, real IGV deployment or real genomic data are used.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE=Path(__file__).resolve().parents[1]
SCRIPT=(BASE/'igv-track-helper.user.js').read_text()
HTML=(BASE/'tests/fixture.html').read_text()
RESULTS=[]

def main():
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  context=browser.new_context(viewport={'width':1360,'height':1100})
  context.set_default_timeout(4000)
  errors=[]
  def launch():
   page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   page.set_content(HTML)
   page.evaluate('''()=>{window.__storage={};Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>__storage[k]??null,setItem:(k,v)=>__storage[k]=v}});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>window.copied=t}});}''')
   page.add_script_tag(content=SCRIPT);page.wait_for_timeout(220);return page
  def log(x):RESULTS.append(x);print('PASS',x,flush=True)
  def pause(page):page.wait_for_timeout(210)
  def ui(page,s):return page.locator('#igv-track-helper-v3 '+s)
  def click(page,id):ui(page,'#'+id).click();pause(page)
  def order(page,b='fixtureBrowser'):return page.evaluate(f'{b}.trackViews.map(tv=>tv.track.name)')
  def selected(page,b='fixtureBrowser'):return page.evaluate(f'{b}.trackViews.filter(tv=>tv.box?.checked).map(tv=>tv.track.name)')
  def choose(page,names,b='fixtureBrowser'):
   page.evaluate('''({names,b})=>{const obj=window[b];for(const tv of obj.trackViews){if(tv.box&&tv.box.checked!==names.includes(tv.track.name))tv.box.click();}}''',{'names':names,'b':b});pause(page)
  def handle(page,name,b='fixtureBrowser'):
   return page.evaluate('''({name,b})=>{const r=window[b].trackViews.find(v=>v.track.name===name).dragHandle.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}''',{'name':name,'b':b})
  def drag(page,name,target,where='before',b='fixtureBrowser',drop=True):
   a=handle(page,name,b);t=handle(page,target,b)
   page.mouse.move(a['x']+a['width']/2,a['y']+a['height']/2);page.mouse.down()
   page.mouse.move(t['x']+t['width']/2,t['y']+(7 if where=='before' else t['height']-7),steps=9)
   if drop:page.mouse.up();pause(page)
  def assert_alignment(page,b='fixtureBrowser'):
   result=page.evaluate('''b=>{const o=window[b], ids=o.trackViews.map(tv=>tv.track.id);return [...o.columnContainer.children].every(c=>JSON.stringify([...c.children].map(x=>x.dataset.testTrack))===JSON.stringify(ids));}''',b)
   assert result,'parallel columns differ'
  page=launch()
  assert page.locator('#igv-track-helper-v3').count()==0
  page.locator('#mode').click();pause(page)
  assert ui(page,'#all').is_visible()
  assert ui(page,'#presets, #visibility, #visible, #hidden, #import-file, #export').count()==0
  r=page.locator('#igv-track-helper-v3').bounding_box();assert abs(r['x']+r['width']-1352)<1 and abs(r['y']-8)<1
  log('No presets/visibility controls; 8px top/right; auto-show only in selection mode')
  click(page,'all');assert len(selected(page))==10
  assert page.evaluate('fixtureBrowser.trackViews.filter(tv=>tv.box).every(tv=>tv.track.selected===tv.box.checked)')
  click(page,'invert');assert selected(page)==[]
  click(page,'undo');assert len(selected(page))==10
  click(page,'redo');assert selected(page)==[]
  log('Select All / Invert / Undo / Redo use native selection state')
  boxes=page.locator('#viewer-one input[name="track-select"]')
  boxes.nth(0).click();pause(page);boxes.nth(4).click(modifiers=['Shift']);pause(page)
  assert len(selected(page))==5
  click(page,'undo');assert len(selected(page))==1
  click(page,'clear');pause(page)
  page.evaluate('''()=>{for(const tv of fixtureBrowser.trackViews){if(tv.box){tv.box.style.display='none';const l=tv.trackSelectionContainer.querySelector('label');l.textContent='□';l.style.cursor='pointer';}}}''')
  labels=page.locator('#viewer-one .track-selection label');labels.nth(0).click();pause(page);labels.nth(3).click(modifiers=['Shift']);pause(page)
  assert len(selected(page))==4
  page.evaluate('''()=>{for(const tv of fixtureBrowser.trackViews){if(tv.box){tv.box.style.display='';tv.trackSelectionContainer.querySelector('label').textContent='';}}}''')
  log('Shift range and custom-label Shift-click remain functional')
  click(page,'clear');ui(page,'#filters summary').click();ui(page,'#include').fill('K562');ui(page,'#exclude').fill('input|control');ui(page,'#regex').check();ui(page,'#type').select_option('format:bigwig');click(page,'apply')
  assert selected(page)==['K562_ATAC_rep1.bigWig','K562_ATAC_rep2.bigWig','K562_H3K27ac.bigWig']
  click(page,'copy');assert page.evaluate('window.copied')=='\n'.join(selected(page))
  ui(page,'#include').fill('[');pause(page);assert ui(page,'#apply').is_disabled()
  click(page,'reset-filter')
  log('Name/include/exclude/type filters, invalid-regex guard and Copy Names')
  original=order(page); moving=selected(page)
  assert 'Drag any selected track handle' in ui(page,'#drag-hint').inner_text()
  assert page.evaluate('window.igv === undefined && window.igvBrowser === undefined && window.browser === undefined')
  drag(page,moving[1],'K562_peaks.bed','after',drop=False)
  assert page.locator('[data-igv-group-drag="line"]').is_visible()
  assert 'Move 3 tracks' in page.locator('[data-igv-group-drag="badge"]').inner_text()
  page.screenshot(path=str(BASE/'tests/group-drag-preview.png'))
  page.mouse.up();pause(page)
  remaining=[x for x in original if x not in moving];pos=remaining.index('K562_peaks.bed')+1;expected=remaining[:pos]+moving+remaining[pos:]
  assert order(page)==expected,(order(page),expected)
  assert selected(page)==moving;assert_alignment(page)
  assert page.evaluate('window.nativeDragStarts')==0
  assert page.evaluate('fixtureBrowser.events.filter(e=>e.event==="trackorderchanged").length')==1
  assert page.evaluate('fixtureBrowser.toJSON().tracks.map(t=>t.name)')==expected
  assert page.evaluate('fixtureBrowser.toJSON().tracks.filter(t=>!["ideogram","ruler"].includes(t.type)).every((t,i,a)=>i===0||t.order>a[i-1].order)')
  log('Non-adjacent group drag via canvas adapter updates every column/model/session order; native drag suppressed')
  after=order(page);click(page,'undo');assert order(page)==original;assert selected(page)==moving;assert_alignment(page)
  click(page,'redo');assert order(page)==after;assert_alignment(page)
  log('Group move Undo / Redo preserve original relative order and selection')
  click(page,'clear');assert selected(page)==[];click(page,'undo');assert selected(page)==moving;click(page,'undo');assert order(page)==original
  log('Selection history and order history interleave correctly')
  drag(page,moving[-1],'Sequence','before')
  assert order(page)[:2]==original[:2];assert order(page)[2:5]==moving;assert_alignment(page)
  log('Moving upward keeps ruler/ideogram pinned and selected tracks in original order')
  before=order(page)
  a=handle(page,moving[0]);page.mouse.move(a['x']+6,a['y']+20);page.mouse.down();page.mouse.up();pause(page)
  assert order(page)==before
  drag(page,moving[0],'Variants.vcf','after',drop=False);page.mouse.move(1000,950);page.mouse.up();pause(page)
  assert order(page)==before and page.locator('[data-igv-group-drag]').count()==0
  log('Click-without-drag and release outside viewer leave order unchanged')
  # No external/public browser object is required. One canvas reference is sufficient.
  page.evaluate('''()=>{let keep=true;for(const tv of fixtureBrowser.trackViews)for(const vp of tv.viewports)for(const c of vp.viewportElement.querySelectorAll('canvas')){if(keep){keep=false;continue;}delete c._data;}}''')
  page.add_script_tag(content=SCRIPT);pause(page)
  assert 'Drag any selected track handle' in ui(page,'#drag-hint').inner_text()
  assert page.locator('#igv-track-helper-v3').count()==1
  drag(page,moving[0],'Variants.vcf','after');assert_alignment(page)
  log('A single rendered canvas discovers all tracks; reinstall is idempotent')
  # Failure is rolled back and creates no success claim.
  failure_before=order(page);page.evaluate('fixtureBrowser.failNextReorder=true')
  drag(page,moving[0],'Sequence','before')
  assert order(page)==failure_before;assert_alignment(page);assert 'Could not complete' in ui(page,'#message').inner_text()
  log('Native reorder failure is rolled back and reported without a success claim')
  # Native one-track and unselected-track dragging are not replaced.
  choose(page,[moving[0]]);n=page.evaluate('nativeDragStarts');drag(page,moving[0],'Sequence','after')
  assert page.evaluate('nativeDragStarts')==n+1
  choose(page,moving);n=page.evaluate('nativeDragStarts');drag(page,'GM12878_ATAC.bigWig','Variants.vcf','after')
  assert page.evaluate('nativeDragStarts')==n+1
  log('Single-track and unselected-handle native dragging remain untouched')
  page.close();page=launch();page.locator('#mode').click();pause(page)
  # Create a second instance; the selected group never crosses viewers.
  page.evaluate('''()=>{const host=document.createElement('div');host.id='viewer-two';host.className='viewer';document.body.append(host);window.otherBrowser=makeViewer(host,[['Other_A.bigWig','wig','bigwig'],['Other_B.bigWig','wig','bigwig']],true);}''')
  pause(page);page.wait_for_timeout(3500)
  choose(page,['Other_A.bigWig','Other_B.bigWig'],'otherBrowser');other=order(page,'otherBrowser')
  choose(page,['K562_ATAC_rep1.bigWig','K562_ATAC_rep2.bigWig'])
  drag(page,'K562_ATAC_rep2.bigWig','GM12878_H3K27ac.bigWig','after')
  assert order(page,'otherBrowser')==other;assert len(selected(page,'otherBrowser'))==2
  log('Multiple IGV viewers remain isolated during group reorder')
  # Addition/removal while dragging must cancel safely.
  before=order(page);drag(page,'K562_ATAC_rep1.bigWig','Variants.vcf','before',drop=False)
  page.evaluate("fixtureBrowser.addTrack(['During_drag.bigWig','wig','bigwig'])")
  page.mouse.up();pause(page)
  assert order(page)==before+['During_drag.bigWig'] and page.locator('[data-igv-group-drag]').count()==0
  log('Track addition during drag cancels the move safely')
  # Dynamic ordering after a native reorder is reflected in the range selector.
  click(page,'clear');boxes=page.locator('#viewer-one input[name="track-select"]')
  boxes.nth(2).click();pause(page);boxes.nth(5).click(modifiers=['Shift']);pause(page)
  assert len(selected(page))==4
  log('Shift range follows the new visual track order')
  # DOM-only unsupported build: disable group operation instead of moving one.
  page.evaluate('fixtureBrowser.reorderTracks=undefined');page.wait_for_timeout(1400)
  assert 'unavailable' in ui(page,'#drag-hint').inner_text()
  selected_before=selected(page);o=order(page);a=handle(page,selected_before[0]);n=page.evaluate('nativeDragStarts')
  page.mouse.move(a['x']+6,a['y']+12);page.mouse.down();page.mouse.move(a['x']+6,a['y']+80);page.mouse.up();pause(page)
  assert order(page)==o and page.evaluate('nativeDragStarts')==n
  click(page,'all');assert len(selected(page))==11
  log('Unsupported sorting adapter refuses group move while selection tools still work')
  page.close();page=launch();page.locator('#mode').click();pause(page)
  # Inner-scroller edge autoscroll with many tracks.
  page.evaluate('''()=>{fixtureBrowser.columnContainer.style.maxHeight='390px';for(let i=0;i<25;i++)fixtureBrowser.addTrack(['Extra_'+i+'.bigWig','wig','bigwig']);}''');pause(page)
  choose(page,['K562_ATAC_rep1.bigWig','K562_ATAC_rep2.bigWig']);before=order(page)
  a=handle(page,'K562_ATAC_rep1.bigWig');bounds=page.evaluate('''()=>{const r=fixtureBrowser.columnContainer.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}}''')
  page.mouse.move(a['x']+6,a['y']+20);page.mouse.down();page.mouse.move(a['x']+6,bounds['y']+bounds['h']-3,steps=8);page.wait_for_timeout(500)
  assert page.evaluate('fixtureBrowser.columnContainer.scrollTop')>100
  page.mouse.up();pause(page);assert order(page)!=before;assert_alignment(page)
  log('Group dragging autoscrolls the inner track list at its edge')
  # Selection state persists if names are duplicated: mapping uses objects, not names.
  page.close();page=launch();page.locator('#mode').click();pause(page)
  page.evaluate('''()=>{const a=fixtureBrowser.trackViews.filter(v=>v.box);a[0].track.name='Duplicate';a[2].track.name='Duplicate';a[0].viewports.forEach(v=>v.viewportElement.querySelector('.igv-track-label').textContent='Duplicate');a[2].viewports.forEach(v=>v.viewportElement.querySelector('.igv-track-label').textContent='Duplicate');}''');pause(page)
  choose(page,['Duplicate']);drag(page,'Duplicate','Variants.vcf','after')
  assert selected(page)==['Duplicate','Duplicate'];assert_alignment(page)
  log('Duplicate track names are safely resolved by track object identity')
  # Title bar still moves/collapses; only settings remain in storage.
  click(page,'collapse');header=ui(page,'header').bounding_box()
  page.mouse.move(header['x']+35,header['y']+15);page.mouse.down();page.mouse.move(header['x']-100,header['y']+85,steps=6);page.mouse.up();pause(page)
  assert page.evaluate("JSON.parse(localStorage.getItem('igv-track-helper:v3:settings')).top")>50
  assert page.evaluate("Object.keys(__storage).every(k=>k.endsWith('settings'))")
  click(page,'collapse');click(page,'reset-position')
  log('Toolbar dragging/collapse persists only UI settings, not presets')
  assert not errors,errors
  log('No uncaught JavaScript errors in checked scenarios')
  page.screenshot(path=str(BASE/'toolbar-preview.png'))
  page.close();browser.close()
 (BASE/'tests/results.json').write_text(json.dumps({'version':'0.4.0','environment':'Offline Chromium, synthetic native-shaped IGV test double; NOT a live KU Leuven deployment','passed':len(RESULTS),'checks':RESULTS},indent=2)+'\n')
 print('TOTAL',len(RESULTS))

if __name__=='__main__':main()
