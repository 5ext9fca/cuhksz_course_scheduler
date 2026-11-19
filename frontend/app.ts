import { checkRequirements } from './requirements.js';
import { acceptsTutorial } from './pairing.js';
import { connectSync } from './sync.js';
import { parseCatalog, parseHistory, courseKey, minute, weekdays, type Section, type Meeting } from './catalog.js';
import type { Slot, Candidate } from './solver.js';
type InputID='search'|'rank'|'earliest'|'latest'|'knownOnly'|'verifiedOnly'|'hidePassed'|'openOnly'|'file'|'historyFile';
type SelectID='subject'|'requirement'|'gap';
function $(id:InputID):HTMLInputElement;
function $(id:SelectID):HTMLSelectElement;
function $(id:'dialog'):HTMLDialogElement;
function $(id:'prev'|'next'):HTMLButtonElement;
function $(id:string):HTMLElement;
function $(id:string){return document.getElementById(id)!;}
const palette=[['#d9ece0','#206342'],['#f8e6cb','#87551c'],['#dfe9f9','#345c87'],['#eadff3','#755087'],['#f6dfe0','#934b59'],['#dbefec','#2d6c66']];
const clock=(n:number)=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
function el<K extends keyof HTMLElementTagNameMap>(tag:K,text:string|null=null,cls?:string){const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;}
function button(text:string,fn:()=>void,cls?:string){const b=el('button',text,cls);b.onclick=fn;return b;}
function tint<T extends HTMLElement>(e:T,idx:number){const [bg,fg]=palette[idx%palette.length];e.style.setProperty('--tint',bg);e.style.setProperty('--fg',fg);return e;}
let hasHistory=false;
let historyCourses=new Map<string,string>();
let catalog:ReturnType<typeof parseCatalog>, selected=new Set<string>(), pins=new Map<string,Map<string,string>>(), free=new Set<number>(), onlySelected=false;
let worker:Worker|null=null,total=0n,rank=1n,current:Section[]=[];
const workerURL=new URL('./solver.js',import.meta.url);
function stop(){if(worker)worker.terminate();worker=null;}
function chosen(){return [...selected].map(c=>catalog.byCode.get(c)!);}
function applyCatalog(parsed:ReturnType<typeof parseCatalog>,fromSync=false){
  const keep=fromSync&&parsed.term===catalog?.term;
  stop(); catalog=parsed;
  if(keep){
    for(const code of selected)if(!catalog.byCode.has(code)){selected.delete(code);pins.delete(code);}
    for(const [code,locks] of pins)for(const [type,id] of locks){
      if(!catalog.byCode.get(code)?.groups.get(type)?.some(s=>s.id===id))locks.delete(type);
    }
  }else{selected.clear();pins.clear();free.clear();onlySelected=false;}
  const categories=[...new Set(catalog.courses.flatMap(c=>c.evidence.map(e=>e.requirement).filter(Boolean)))].sort();
  $('requirement').replaceChildren(new Option('全部修读要求',''),...categories.map(x=>new Option(x,x)));
  $('requirement').hidden=!categories.length;
  $('search').value='';$('subject').replaceChildren(new Option('全部学科',''));
  for(const s of [...new Set(catalog.courses.map(c=>c.subject))].sort())$('subject').add(new Option(s,s));
  if(!keep){$('openOnly').checked=false;$('knownOnly').checked=true;$('verifiedOnly').checked=false;$('gap').value='0';$('earliest').value='';$('latest').value='';}
  $('catalogMeta').textContent=[catalog.label,catalog.major,fromSync?'SIS 同步目录':'已导入目录'].filter(Boolean).join('  ·  ');
  $('importError').textContent='';drawDays();refresh();
}
function toggle(code:string){
  if(selected.has(code)){selected.delete(code);pins.delete(code);}else selected.add(code);
  refresh();
}
function drawCourses(){
  const norm=(s:string)=>s.toLowerCase().replace(/\s+/g,'');
  const q=norm($('search').value),sub=$('subject').value,list=document.createDocumentFragment();
  let n=0;
  for(const c of catalog?.courses||[]){
    const passed=historyCourses.has(courseKey(c.code));
    if($('requirement').value&&!c.evidence.some(e=>e.requirement===$('requirement').value))continue;
    if(passed&&$('hidePassed').checked&&!selected.has(c.code))continue;
    if((onlySelected&&!selected.has(c.code))||(sub&&sub!==c.subject)||(q&&!norm([c.code,c.title,...c.teachers].join(' ')).includes(q)))continue;
    n++;const b=button('',()=>toggle(c.code),'course');b.setAttribute('aria-pressed',String(selected.has(c.code)));
    const label=el('span');label.append(el('span',c.code,'code'),el('span',c.title,'title'));
    if(c.evidence.length){
      const notes=c.evidence.map(e=>[e.requirement,e.page?'PDF 第 '+e.page+' 页':'',e.path?.join(' / ')].filter(Boolean).join(' · '));
      label.append(el('span',[...new Set(notes)].join('；'),'evidence'));
    }
    const raw=c.requirements.raw_text;
    label.append(el('span',raw==null?'注册要求待确认':raw||'SIS 未列注册要求','evidence'));
    if(passed)label.firstElementChild!.append(el('span','已修','passed'));
    const action=el('span',selected.has(c.code)?'✓':'+','action');action.setAttribute('aria-hidden','true');b.append(label,action);list.append(b);
  }
  if(!n)list.append(el('p',catalog?'没有匹配的课程':'导入 sis-catalog 导出的 JSON 后即可选课。','empty'));
  $('catalogCount').textContent=catalog?n+' / '+catalog.courses.length+' 门':'尚未导入';
  $('onlySelected').setAttribute('aria-pressed',String(onlySelected));$('courseList').replaceChildren(list);
}
function drawSelection(){
  const wrap=$('selection');wrap.replaceChildren(el('strong','已选课程 · '+selected.size));
  if(!selected.size)wrap.append(el('span','从课程目录添加要一起修读的课程','subtle'));
  chosen().forEach((c,i)=>{const b=tint(button(c.code,()=>toggle(c.code),'chip'),i);b.setAttribute('aria-label','移除 '+c.code);b.append(el('b','×'));wrap.append(b);});
}
function drawDays(){
  $('freeDays').replaceChildren(...weekdays.map((d,i)=>{const b=button('周'+d,()=>{if(free.has(i))free.delete(i);else free.add(i);drawDays();solve();});b.setAttribute('aria-pressed',String(free.has(i)));return b;}));
}
function drawPins(){
  const wrap=$('pins');wrap.replaceChildren();if(!selected.size)return;
  const box=el('details');box.append(el('summary','指定教学班'));const rows=el('div',null,'fieldrow');
  for(const c of chosen())for(const [type,secs] of c.groups){
    const label=el('label',c.code+' · '+type);const select=el('select');select.add(new Option('任意教学班',''));
    const lecture=catalog.sections.get(pins.get(c.code)?.get('LEC')||'');
    const choices=type==='TUT'&&lecture?secs.filter(s=>acceptsTutorial(lecture.rule,s.id)):secs;
    for(const s of choices)select.add(new Option(s.section+' · '+s.id,s.id));
    select.value=pins.get(c.code)?.get(type)||'';
    select.onchange=()=>{if(!pins.has(c.code))pins.set(c.code,new Map());const locks=pins.get(c.code)!;
      locks.set(type,select.value);
      if(type==='LEC'){
        const lec=catalog.sections.get(select.value);
        if(lec&&locks.get('TUT')&&!acceptsTutorial(lec.rule,locks.get('TUT')!))locks.delete('TUT');
        drawPins();$('pins').querySelector('details')!.open=true;
      }
      solve();};
    label.append(select);rows.append(label);
  }
  box.append(rows);wrap.append(box);
}
function refresh(){drawCourses();drawSelection();drawPins();solve();}
function blank(msg:string){$('preview').replaceChildren(el('p',msg,'empty'));}
function solve(){
  stop();total=0n;rank=1n;current=[];$('nav').hidden=true;
  const early=$('earliest').value,late=$('latest').value,gap=Number($('gap').value),known=$('knownOnly').checked,open=$('openOnly').checked;
  const active=[open?'仅开放班':'',known?'排除待定':'',$('verifiedOnly').checked?'仅已核实配对':'',free.size?'空闲日 '+free.size+' 天':'',early||late?'已限时段':'',gap?'课间 '+gap+' 分钟':'',[...pins.values()].some(m=>[...m.values()].some(Boolean))?'已指定班级':''].filter(Boolean);
  $('filterSummary').textContent=active.join(' · ')||'全部教学班';
  $('result').textContent='';$('eligibility').replaceChildren();
  if(!catalog){blank('等待导入开课目录。');return;}
  if(!selected.size){blank('选择课程后，此处将显示所有符合条件的方案。');return;}
  if(early&&late&&early>=late){blank('最晚下课时间须晚于最早上课时间。');return;}
  const codes=new Set([...selected].map(courseKey));
  let blocked=false;
  for(const c of chosen()){
    const checks=checkRequirements(c.requirements,hasHistory?historyCourses:null,codes);
    for(const msg of checks.blocked)$('eligibility').append(el('p',c.code+' · 未满足 · '+msg,'notice'));
    for(const msg of checks.pending)$('eligibility').append(el('p',c.code+' · 待核实 · '+msg,'subtle'));
    blocked ||= checks.blocked.length>0;
  }
  if(blocked){$('result').textContent='0 个可行方案';blank('请调整选课或修读记录，上方列出了未满足的注册要求。');return;}
  const groups=[];
  for(const c of chosen()){
    if(!c.groups.size){blank(c.code+' 没有教学班。');return;}
    for(const [type,secs] of c.groups){
      const lock=pins.get(c.code)?.get(type);
      const hasTut=c.groups.has('TUT');
      const options=secs.filter(s=>(type!=='LEC'||(
        (!s.rule?.required||s.rule.class_numbers.length>0)&&(!hasTut||s.rule||!$('verifiedOnly').checked)
      ))&&(!lock||s.id===lock)&&(!open||/^(开放|開放|open)$/i.test(s.status))&&(!known||!s.unknown)&&
        s.slots.every(x=>!free.has(x.day)&&(!early||x.start>=minute(early))&&(!late||x.end<=minute(late))));
      const candidates:Candidate[]=options.map(({id,code,type,slots,rule})=>({id,code,type,slots,rule}));
      if(type==='TUT'&&!lock&&c.groups.get('LEC')?.some(lec=>lec.rule?.required===false)){
        candidates.push({id:null,code:c.code,type,slots:[],rule:null});
      }
      if(!candidates.length){$('result').textContent='0 个可行方案';blank(c.code+' 的 '+type+' 班均不满足筛选条件。');return;}
      groups.push(candidates);
    }
  }
  $('result').textContent='正在计算全部方案…';blank('正在检查上课日期与时间冲突…');
  const w=worker=new Worker(workerURL,{type:"module"});
  w.onmessage=({data})=>{
    if(w!==worker)return;
    if(data.error){$('result').textContent='计算失败';blank(data.error);return;}
    if(data.total!==undefined)total=BigInt(data.total);
    rank=BigInt(data.rank);current=data.ids.map((id:string)=>catalog.sections.get(id)!);
    $('result').textContent=total.toLocaleString('zh-CN')+' 个可行方案';
    if(!total){blank('没有同时满足时间与教学班配对的方案。可调整指定班级、课程或筛选。');return;}
    $('nav').hidden=false;$('prev').disabled=rank<=1n;$('next').disabled=rank>=total;$('rank').value=String(rank);
    drawTimetable();
  };
  w.onerror=()=>{if(w===worker){$('result').textContent='计算失败';blank('浏览器未能运行排课线程，请使用新版浏览器重新打开。');}};
  w.postMessage({groups,gap});
}
function go(n:bigint){if(worker&&n>=1n&&n<=total)worker.postMessage({rank:String(n)});else $('rank').value=String(rank);}
function meetingText(m:Meeting){
  return [m.days_and_times||'时间待定',m.room,m.instructor,m.date_range].filter(Boolean).join(' · ');
}
function sectionDetails(s:Section){
  const div=el('div',null,'detailitem');
  div.append(el('strong',s.code+' · '+s.section),el('div',[catalog.byCode.get(s.code)!.title,'班号 '+s.id,s.status,s.session].filter(Boolean).join(' · '),'subtle'));
  if(s.type==='LEC'&&catalog.byCode.get(s.code)!.groups.has('TUT')){
    const rule=s.rule;
    const label=rule?(rule.required?'必须选一班':'可不选辅导班')+(rule.class_numbers.length?' · '+rule.class_numbers.map(id=>catalog.sections.get(id)!.section+' ('+id+')').join('、'):''):'配对待确认';
    div.append(el('div','SIS 辅导班选项：'+label));
  }
  for(const m of s.meetings)div.append(el('div',meetingText(m)));
  if(!s.meetings.length)div.append(el('div','时间待定'));return div;
}
function modal(title:string,content:HTMLElement[]){$('dialogTitle').textContent=title;$('dialogContent').replaceChildren(...content);$('dialog').showModal();}
function drawTimetable(){
  const idx=new Map([...selected].map((code,i)=>[code,i]));
  const sections=current.slice().sort((a,b)=>idx.get(a.code)!-idx.get(b.code)!||a.type.localeCompare(b.type));
  const events:(Slot & {s:Section})[]=[];
  for(const s of sections){
    const seen=new Set();
    for(const t of s.slots){
      const key=[t.day,t.start,t.end].join('-');
      if(!seen.has(key)){seen.add(key);events.push({...t,s});}
    }
  }
  const wrap=$('preview');wrap.replaceChildren();
  if(events.length){
    const days=Math.max(5,...events.map(t=>t.day+1));
    const first=Math.min(8, ...events.map(t=>Math.floor(t.start/60)));
    const end=Math.max(18,...events.map(t=>Math.ceil(t.end/60)));
    const height=(end-first)*49,hour=49;
    const scroll=el('div',null,'gridscroll'),grid=el('div',null,'grid');
    grid.style.setProperty('--days',String(days));grid.style.setProperty('--height',height+'px');grid.style.setProperty('--hour',hour+'px');
    const head=el('div',null,'weekhead');head.append(el('span','时间'));
    for(let d=0;d<days;d++)head.append(el('span','周'+weekdays[d]));
    const body=el('div',null,'weekbody'),axis=el('div',null,'axis');
    for(let h=first;h<end;h++){const lab=el('span',clock(h*60));lab.style.top=((h-first)*hour+3)+'px';axis.append(lab);}
    body.append(axis);
    for(let d=0;d<days;d++){
      const col=el('div',null,'daycol'),items=events.filter(t=>t.day===d).sort((a,b)=>a.start-b.start||a.end-b.end);
      // Separate date-disjoint meetings that occupy the same weekly grid cell.
      let cluster:(Slot & {s:Section;lane:number})[]=[],ends:number[]=[];
      function paint(){
        for(const t of cluster){
          const s=t.s,b=tint(button('',()=>modal('教学班详情',[sectionDetails(s)]),'event'),idx.get(s.code)!);
          const times=clock(t.start)+'–'+clock(t.end);
          b.title=[s.code,catalog.byCode.get(s.code)!.title,s.section,times,...s.meetings.map(meetingText)].join('\n');
          b.setAttribute('aria-label',s.code+' '+s.section+' 周'+weekdays[d]+' '+times);
          b.style.top=((t.start-first*60)/60*hour)+'px';b.style.height=Math.max(5,(t.end-t.start)/60*hour-1)+'px';
          b.style.left='calc('+t.lane/ends.length*100+'% + 2px)';b.style.width='calc('+100/ends.length+'% - 4px)';
          b.append(el('strong',s.code),el('span',catalog.byCode.get(s.code)!.title),el('small',s.section+' · '+times));col.append(b);
        }
        cluster=[];ends=[];
      }
      for(const t of items){
        if(ends.length&&ends.every(v=>v<=t.start))paint();
        let lane=ends.findIndex(v=>v<=t.start);if(lane<0)lane=ends.length;
        ends[lane]=t.end;cluster.push({...t,lane});
      }
      paint();body.append(col);
    }
    grid.append(head,body);scroll.append(grid);wrap.append(scroll);
  }
  const unknown=sections.filter(s=>s.unknown);
  const unverified=sections.filter(s=>s.type==='LEC'&&!s.rule&&catalog.byCode.get(s.code)!.groups.has('TUT'));
  if(unverified.length)wrap.append(el('p','讲辅配对待确认：'+unverified.map(s=>s.code+' '+s.section).join('、'),'padded notice'));
  if(unknown.length)wrap.append(el('p','含未确定时段，需另行核对：'+unknown.map(s=>s.code+' '+s.section).join('、'),'padded notice'));
  const info=el('details',null,'details');info.append(el('summary','教学班明细 · '+sections.length+' 个班'),...sections.map(sectionDetails));wrap.append(info);
}
function setHistory(records:Map<string,string>|null){
  hasHistory=records!==null;
  historyCourses=records||new Map();
  $('historyTools').hidden=!records;
  $('hidePassed').checked=true;
  $('historyList').textContent='已修 '+historyCourses.size+' 门 · 查看';
  drawCourses();solve();
}
function bindImport(trigger:string,input:"file"|"historyFile",apply:(value:unknown)=>void){
  let version=0;
  $(trigger).onclick=()=>$(input).click();
  $(input).onchange=async ()=>{
    const file=$(input).files?.[0];$(input).value='';if(!file)return;
    const attempt=++version;
    try{
      const data=JSON.parse(await file.text());
      if(attempt!==version)return;
      apply(data);$('importError').textContent='';
    }catch(err){
      if(attempt===version)$('importError').textContent='导入失败。'+(err instanceof SyntaxError?'文件不是有效的 JSON。':err instanceof Error?err.message:String(err));
    }
  };
}
bindImport('importBtn','file',data=>applyCatalog(parseCatalog(data)));
bindImport('historyBtn','historyFile',data=>setHistory(parseHistory(data)));
$('hidePassed').onchange=drawCourses;
$('historyList').onclick=()=>{
  const list=el('ul',null,'history-list');
  for(const name of [...historyCourses.values()].sort())list.append(el('li',name));
  const clear=button('清除修读记录',()=>{setHistory(null);$('dialog').close();},'text-button');
  modal('已修课程 · '+historyCourses.size,[el('p','按通过成绩认定，每个课号只计一次。隐藏已修时，已选课程仍会保留。'),list,clear]);
};
$('onlySelected').onclick=()=>{onlySelected=!onlySelected;drawCourses();};
$('requirement').onchange=drawCourses;$('search').oninput=drawCourses;$('subject').onchange=drawCourses;
for(const id of ['earliest','latest','gap','openOnly','knownOnly','verifiedOnly'])$(id).onchange=solve;
$('prev').onclick=()=>go(rank-1n);$('next').onclick=()=>go(rank+1n);
$('rank').onchange=()=>{const v=$('rank').value.trim();if(/^\d+$/.test(v))go(BigInt(v));else $('rank').value=String(rank);};
$('rank').onkeydown=e=>{if(e.key==='Enter')$('rank').blur();};
$('help').onclick=()=>modal('使用说明',[
  '填写查询学期，选择专业范围后点击「刷新目录与修读记录」。学校要求登录时请在 scraper 打开的学校页面完成登录。刷新过程中仍可在原目录排课。',
  '点击「导入目录」打开 sis-catalog 导出的学期 JSON（含专业筛选的目录也可）。新目录从空选课开始，文件只在本地浏览器中读取。',
  '可选导入 sis-export 的 completed.json。已注册或已完成且成绩为 A 至 D（含正负号）、P、PA、Pass、DI 或 Distinction 的课程计为已修。已修课程默认从目录中隐藏，取消「隐藏已修」即可选择重修。两种文件可以按任意顺序导入。',
  '每门已选课都要修读。讲课与辅导班遵守 SIS 列出的必选、可选和允许班号，其他教学组成各选一班。未知配对暂按一讲一辅计算，可勾选「仅已核实讲辅配对」排除待确认组合。',
  '同一日期的上课时间重叠或课间短于设定值，会排除该组合。日期未知时按整学期检查。允许时间待定班后，其未知时段不能用于排除冲突。',
  '箭头切换方案，输入方案编号并按回车可直接跳转。点击课表色块可查看完整上课日期、教室和教师。'
].map(t=>el('p',t)));
drawDays();refresh();

connectSync((data,history)=>{
  const catalog=parseCatalog(data);
  const records=parseHistory(history);
  applyCatalog(catalog,true);
  setHistory(records);
});
