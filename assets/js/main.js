/* ========== Config & state ========== */
const DEFAULT_CFG = { owner:'', repo:'', path:'data', branch:'main' };
let cfg = loadCfg();
let examsList = [];      // ["UPSC","MPSC"...]
let examData = null;     // loaded JSON for current exam (in-memory)
let current = { exam:'', subject:'', book:'', chapter:'' };
const LASTN = 3;
const noteDebounce = 900;
let noteTimers = {}; // per-question debounce
let autosaveTimer = null;

/* ========== Helpers ========== */
function log(msg){ document.getElementById('saveHint').textContent = msg; }
function loadCfg(){
  try{ const raw = localStorage.getItem('qtracker_cfg'); if(raw) return JSON.parse(raw); }catch(e){}
  return DEFAULT_CFG;
}
function saveCfgLocal(c){ localStorage.setItem('qtracker_cfg', JSON.stringify(c)); }

/* ========== GitHub API helpers ========== */
function apiBase(){ return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}`; }
function fileUrl(path){ return `${apiBase()}/contents/${encodeURIComponent(path)}?ref=${cfg.branch}`; }

async function ghGet(path){
  const token = localStorage.getItem('qtracker_token');
  if(!token) throw new Error('No token in localStorage');
  const res = await fetch(fileUrl(path), { headers: { 'Authorization': 'token '+token, 'Accept':'application/vnd.github.v3+json' }});
  return res;
}

async function ghPut(path, contentStr, message, sha=null){
  const token = localStorage.getItem('qtracker_token');
  if(!token) throw new Error('No token in localStorage');
  const body = { message: message || 'Update by QTracker', content: btoa(unescape(encodeURIComponent(contentStr))), branch: cfg.branch };
  if(sha) body.sha = sha;
  const res = await fetch(apiBase() + '/contents/' + encodeURIComponent(path), {
    method:'PUT',
    headers: { 'Authorization': 'token '+token, 'Accept':'application/vnd.github.v3+json' },
    body: JSON.stringify(body)
  });
  return res;
}

/* ========== Exams list functions ========== */
async function loadExams(){
  try{
    const resp = await ghGet(cfg.path + '/exams.json');
    if(resp.status===200){
      const j = await resp.json();
      const raw = atob(j.content.replace(/\n/g,'')); examsList = JSON.parse(raw).exams || [];
      populateExamSelect();
      log('Loaded exams.json');
    } else {
      examsList = [];
      populateExamSelect();
      log('exams.json not found. Click Init to create one.');
    }
  }catch(err){ log('Load exams failed: '+err.message); console.error(err); }
}

async function initExams(){
  try{
    const content = JSON.stringify({ exams: [] }, null, 2);
    const res = await ghPut(cfg.path + '/exams.json', content, 'Init exams.json');
    if(res.ok) { log('Created exams.json'); await loadExams(); }
    else { const t = await res.text(); log('Init failed: '+res.status); console.log(t); }
  }catch(err){ log('Init error: '+err.message); }
}

/* ========== Per-exam load/save ========== */
async function loadExamFile(examName){
  try{
    const resp = await ghGet(cfg.path + '/' + examName + '.json');
    if(resp.status===200){
      const j = await resp.json();
      const raw = atob(j.content.replace(/\n/g,'')); examData = JSON.parse(raw);
      // do not keep __sha inside JSON; store separately
      examData.__sha = j.sha;
      if(!examData.subjects) examData.subjects = {};
      populateSelectorsFromData();
      log('Loaded '+examName+'.json');
    } else if(resp.status===404){
      examData = { subjects: {} };
      examData.__sha = null;
      populateSelectorsFromData();
      log('No file for exam. Initialized empty data in-memory.');
    } else {
      const txt = await resp.text(); log('Error loading exam file: '+resp.status); console.error(txt);
    }
  }catch(err){ log('Load exam failed: '+err.message); console.error(err); }
}

async function saveExamFile(commitMsg='Save from QTracker'){
  if(!current.exam) return log('Select an exam first');
  try{
    // create copy without __sha
    const copy = Object.assign({}, examData);
    delete copy.__sha;
    const content = JSON.stringify(copy, null, 2);
    const path = cfg.path + '/' + current.exam + '.json';
    const res = await ghPut(path, content, commitMsg, examData.__sha);
    if(res.status===200 || res.status===201){
      const j = await res.json();
      examData.__sha = j.content.sha;
      log('Saved '+current.exam+'.json');
    } else {
      const txt = await res.text(); console.error(txt); log('GitHub save error: '+res.status);
    }
  }catch(err){ log('Save exam failed: '+err.message); console.error(err); }
}

/* ========== UI population ========== */
function populateExamSelect(){
  const el = document.getElementById('examSelect'); el.innerHTML = '';
  const empty = document.createElement('option'); empty.text = '-- choose exam --'; empty.value=''; el.appendChild(empty);
  examsList.forEach(e => { const o=document.createElement('option'); o.value=o.text=e; el.appendChild(o); });
}

function populateSelectorsFromData(){
  const subjSel = document.getElementById('subjectSelect'), bookSel = document.getElementById('bookSelect'), chapSel = document.getElementById('chapterSelect');
  subjSel.innerHTML=''; bookSel.innerHTML=''; chapSel.innerHTML='';
  const empty = document.createElement('option'); empty.text='-- subject --'; empty.value=''; subjSel.appendChild(empty);
  const subjects = Object.keys(examData.subjects || {});
  subjects.forEach(s => subjSel.appendChild(Object.assign(document.createElement('option'), { value:s, text:s })));
  subjSel.onchange = ()=> {
    bookSel.innerHTML=''; bookSel.appendChild(Object.assign(document.createElement('option'),{value:'',text:'-- book --'}));
    chapSel.innerHTML=''; chapSel.appendChild(Object.assign(document.createElement('option'),{value:'',text:'-- chapter --'}));
    const s = subjSel.value; if(!s) return;
    const books = Object.keys(examData.subjects[s] || {});
    books.forEach(b => bookSel.appendChild(Object.assign(document.createElement('option'),{value:b,text:b})));
    bookSel.onchange = ()=> {
      chapSel.innerHTML=''; chapSel.appendChild(Object.assign(document.createElement('option'),{value:'',text:'-- chapter --'}));
      const b = bookSel.value; if(!b) return;
      const chapters = Object.keys(examData.subjects[s][b] || {});
      chapters.forEach(c => chapSel.appendChild(Object.assign(document.createElement('option'),{value:c,text:c})));
    };
  };
}

/* ========== Helpers for chapter/question structure ========== */
function ensureChapterExists(){
  if(!examData) return false;
  if(!current.subject || !current.book || !current.chapter) return false;
  if(!examData.subjects) examData.subjects = {};
  if(!examData.subjects[current.subject]) examData.subjects[current.subject] = {};
  if(!examData.subjects[current.subject][current.book]) examData.subjects[current.subject][current.book] = {};
  if(!examData.subjects[current.subject][current.book][current.chapter]) {
    // create new chapter
    const tq = prompt('Enter total number of questions for this new chapter (integer):');
    if(!tq) { log('Chapter creation cancelled'); return false; }
    const n = parseInt(tq);
    if(isNaN(n) || n <= 0){ alert('Invalid number'); return false; }
    examData.subjects[current.subject][current.book][current.chapter] = { totalQuestions: n, questions: {} };
  }
  return true;
}

function lastN(arr){ if(!arr) return []; const tail = arr.slice(-LASTN); const pad = Array(Math.max(0, LASTN - tail.length)).fill(undefined); return pad.concat(tail); }

/* ========== Render table ========== */
function renderTable(){
  const tbody = document.querySelector('#questionsTable tbody'); tbody.innerHTML='';
  const controls = document.getElementById('controls');
  if(!current.chapter){ controls.classList.add('d-none'); return; }
  if(!ensureChapterExists()) return;
  const chObj = examData.subjects[current.subject][current.book][current.chapter];
  const tq = chObj.totalQuestions || 0;
  controls.classList.remove('d-none');
  document.getElementById('chapterInfo').textContent = `Exam: ${current.exam} • ${current.subject} → ${current.book} → ${current.chapter} • Q: ${tq}`;

  for(let i=1;i<=tq;i++){
    const q = chObj.questions && chObj.questions[i] ? chObj.questions[i] : { notes:'', attempts:[] };
    const tr = document.createElement('tr');
    const tdNum = document.createElement('td'); tdNum.textContent = i; tr.appendChild(tdNum);

    const tdNotes = document.createElement('td'); tdNotes.className='notes-cell';
    const ta = document.createElement('textarea'); ta.className='form-control form-control-sm'; ta.style.minHeight='56px'; ta.value = q.notes || '';
    ta.addEventListener('input', ()=> {
      if(noteTimers[i]) clearTimeout(noteTimers[i]);
      noteTimers[i] = setTimeout(()=>{
        chObj.questions = chObj.questions || {};
        chObj.questions[i] = chObj.questions[i] || { notes:'', attempts:[] };
        chObj.questions[i].notes = ta.value;
        // scheduleSave();
      }, noteDebounce);
    });
    tdNotes.appendChild(ta);
    tr.appendChild(tdNotes);

    const arr = lastN(q.attempts || []);
    arr.forEach((st, idx)=>{
      const td = document.createElement('td'); td.className='text-center';
      const sp = document.createElement('span'); sp.className='dot';
      const state = st || 'no_data';
      if(state==='correct') sp.classList.add('dot-green');
      else if(state==='wrong') sp.classList.add('dot-red');
      else if(state==='not_attempted') sp.classList.add('dot-yellow');
      else sp.classList.add('dot-gray');

      sp.title = state;
      sp.onclick = ()=>{
        // toggle order: no_data -> correct -> wrong -> not_attempted -> no_data
        const states = ['no_data','correct','wrong','not_attempted'];
        const tail = (q.attempts || []).slice(-LASTN);
        const cur = tail[idx] === undefined ? 'no_data' : tail[idx];
        const curIdx = states.indexOf(cur);
        const next = states[(curIdx + 1) % states.length];
        // compute absolute position in full attempts
        const full = q.attempts || [];
        const absolutePos = full.length - tail.length + idx;
        if(next === 'no_data'){
          if(absolutePos >= 0 && absolutePos < full.length) full[absolutePos] = undefined;
        } else {
          if(absolutePos < 0){
            // pad at start
            const pad = Array(Math.abs(absolutePos)).fill(undefined);
            full.unshift(...pad);
          }
          full[absolutePos] = next;
        }
        chObj.questions = chObj.questions || {};
        chObj.questions[i] = chObj.questions[i] || { notes:'', attempts:[] };
        chObj.questions[i].attempts = full;
        // scheduleSave();
        renderTable();
      };

      td.appendChild(sp);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }
}

/* ========== Actions: mark all / new attempt / add nodes ========== */
// function scheduleSave(){
//   if(autosaveTimer) clearTimeout(autosaveTimer);
//   autosaveTimer = setTimeout(()=> saveExamFile('Auto-save from QTracker'), 1200);
// }

function markAll(state){
  if(!current.chapter) return;
  const chObj = examData.subjects[current.subject][current.book][current.chapter];
  for(let i=1;i<=chObj.totalQuestions;i++){
    chObj.questions = chObj.questions || {};
    chObj.questions[i] = chObj.questions[i] || { notes:'', attempts:[] };
    chObj.questions[i].attempts.push(state);
  }
  // scheduleSave(); 
  renderTable();
}

function newAttemptAll(){
  if(!current.chapter) return;
  const chObj = examData.subjects[current.subject][current.book][current.chapter];
  for(let i=1;i<=chObj.totalQuestions;i++){
    chObj.questions = chObj.questions || {};
    chObj.questions[i] = chObj.questions[i] || { notes:'', attempts:[] };
    chObj.questions[i].attempts.push(undefined);
  }
  // scheduleSave(); 
  renderTable();
}

/* ========== Stats computation (only when button clicked) ========== */
function computeChapterStats(chObj){
  let totalAttempts=0, totalCorrect=0, totalWrong=0, totalNotAttempted=0;
  for(let i=1;i<= (chObj.totalQuestions||0); i++){
    const q = (chObj.questions && chObj.questions[i]) ? chObj.questions[i] : { attempts:[] };
    q.attempts.forEach(s=>{
      if(s === 'correct'){ totalCorrect++; totalAttempts++; }
      else if(s === 'wrong'){ totalWrong++; totalAttempts++; }
      else if(s === 'not_attempted'){ totalNotAttempted++; totalAttempts++; }
    });
  }
  const accuracy = totalAttempts ? (totalCorrect/totalAttempts)*100 : null;
  return { totalAttempts, totalCorrect, totalWrong, totalNotAttempted, accuracy };
}

function computeSubjectSummary(subjectName){
  const subj = examData.subjects[subjectName] || {};
  const chapters = [];
  for(const bookName of Object.keys(subj)){
    for(const chName of Object.keys(subj[bookName])){
      const ch = subj[bookName][chName];
      const st = computeChapterStats(ch);
      chapters.push({ book: bookName, chapter: chName, stats: st });
    }
  }
  return chapters;
}

function showStats(){
  if(!current.chapter){ alert('Load a chapter first'); return; }
  const chObj = examData.subjects[current.subject][current.book][current.chapter];
  const chStats = computeChapterStats(chObj);
  const subjChapters = computeSubjectSummary(current.subject);
  // compute top/bottom by accuracy (ignore chapters with no attempts)
  const list = subjChapters.filter(x=>x.stats.totalAttempts>0).map(x => ({ name: x.book + ' → ' + x.chapter, acc: x.stats.accuracy || 0 }));
  list.sort((a,b)=>b.acc - a.acc);
  const top5 = list.slice(0,5);
  const bottom5 = list.slice(-5).reverse();

  const html = `
    <h6>Chapter: ${current.book} → ${current.chapter}</h6>
    <div>Total attempts: <strong>${chStats.totalAttempts}</strong></div>
    <div>Correct: <strong>${chStats.totalCorrect}</strong>, Wrong: <strong>${chStats.totalWrong}</strong>, Not attempted: <strong>${chStats.totalNotAttempted}</strong></div>
    <div>Accuracy: <strong>${chStats.accuracy===null?'N/A':chStats.accuracy.toFixed(1)+'%'}</strong></div>
    <hr>
    <h6>Top 5 Chapters (by accuracy)</h6>
    <div>${top5.length? top5.map(t=>`<div>${t.name} <span class="badge bg-success badge-small">${t.acc.toFixed(1)}%</span></div>`).join('') : '<div class="muted-small">N/A</div>'}</div>
    <hr>
    <h6>Bottom 5 Chapters</h6>
    <div>${bottom5.length? bottom5.map(t=>`<div>${t.name} <span class="badge bg-danger badge-small">${t.acc.toFixed(1)}%</span></div>`).join('') : '<div class="muted-small">N/A</div>'}</div>
  `;
  document.getElementById('statsModalContent').innerHTML = html;
  const m = new bootstrap.Modal(document.getElementById('statsModal'));
  m.show();
}

/* ========== Import / Export ========== */
document.getElementById('exportBtn').addEventListener('click', ()=>{
  if(!current.exam){ alert('Load an exam to export'); return; }
  const copy = Object.assign({}, examData); delete copy.__sha;
  const blob = new Blob([JSON.stringify(copy, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = current.exam + '.json'; a.click(); URL.revokeObjectURL(url);
});

document.getElementById('importBtn').addEventListener('click', ()=>{
  const input = document.createElement('input'); input.type='file'; input.accept='application/json';
  input.onchange = e => {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try{
        const parsed = JSON.parse(ev.target.result);
        if(!current.exam){ if(!confirm('No exam selected. Import will overwrite in-memory examData variable. Continue?')) return; }
        // merge into current examData
        examData = examData || { subjects:{} };
        // shallow merge subjects
        Object.keys(parsed.subjects || {}).forEach(sub => {
          examData.subjects[sub] = Object.assign(examData.subjects[sub] || {}, parsed.subjects[sub]);
        });
        populateSelectorsFromData();
        renderTable();
        log('Imported JSON into memory. Click Sync to save to GitHub.');
      }catch(err){ alert('Invalid JSON'); }
    };
    reader.readAsText(file);
  };
  input.click();
});

/* ========== Event wiring ========== */
document.getElementById('openSettings').addEventListener('click', ()=>{
  const m = new bootstrap.Modal(document.getElementById('settingsModal'));
  document.getElementById('cfgOwner').value = cfg.owner || '';
  document.getElementById('cfgRepo').value = cfg.repo || '';
  document.getElementById('cfgPath').value = cfg.path || 'data';
  document.getElementById('cfgBranch').value = cfg.branch || 'main';
  document.getElementById('cfgToken').value = localStorage.getItem('qtracker_token') || '';
  m.show();
});

document.getElementById('btnSaveSettings').addEventListener('click', ()=>{
  cfg.owner = document.getElementById('cfgOwner').value.trim();
  cfg.repo = document.getElementById('cfgRepo').value.trim();
  cfg.path = document.getElementById('cfgPath').value.trim() || 'data';
  cfg.branch = document.getElementById('cfgBranch').value.trim() || 'main';
  saveCfgLocal(cfg);
  const tok = document.getElementById('cfgToken').value.trim();
  if(tok) localStorage.setItem('qtracker_token', tok);
  document.querySelectorAll('.btn-close').forEach(b=>b.click());
  log('Settings saved locally. Click Load exams.');
});

document.getElementById('btnLoadExams').addEventListener('click', ()=> loadExams());
document.getElementById('btnInitExams').addEventListener('click', ()=> initExams());

document.getElementById('examSelect').addEventListener('change', async (e)=>{
  const ex = e.target.value;
  if(!ex) { examData = null; current.exam = ''; populateSelectorsFromData(); return; }
  current.exam = ex;
  if(!examsList.includes(ex)) examsList.push(ex);
  await loadExamFile(ex);
  populateExamSelect();
});

document.getElementById('btnAddExam').addEventListener('click', ()=>{
  const name = prompt('Enter new exam name:'); if(!name) return;
  if(!examsList.includes(name)){ examsList.push(name); populateExamSelect(); document.getElementById('examSelect').value = name; current.exam=name; examData={subjects:{}}; }
  else { document.getElementById('examSelect').value = name; current.exam=name; }
  populateSelectorsFromData();
});

document.getElementById('btnAddSubject').addEventListener('click', ()=> {
  if(!examData) examData={subjects:{}};
  const s = prompt('Enter subject name:'); if(!s) return;
  examData.subjects[s] = examData.subjects[s] || {};
  populateSelectorsFromData();
});

document.getElementById('btnAddBook').addEventListener('click', ()=> {
  if(!examData) examData={subjects:{}};
  const subj = prompt('Enter subject for this book (existing or new):'); if(!subj) return;
  if(!examData.subjects[subj]) examData.subjects[subj] = {};
  const book = prompt('Enter book name:'); if(!book) return;
  examData.subjects[subj][book] = examData.subjects[subj][book] || {};
  populateSelectorsFromData();
});

document.getElementById('btnAddChapter').addEventListener('click', ()=> {
  if(!examData) examData={subjects:{}};
  const subj = prompt('Enter subject (existing or new):'); if(!subj) return;
  if(!examData.subjects[subj]) examData.subjects[subj] = {};
  const book = prompt('Enter book (existing or new):'); if(!book) return;
  if(!examData.subjects[subj][book]) examData.subjects[subj][book] = {};
  const chapter = prompt('Enter chapter name:'); if(!chapter) return;
  if(!examData.subjects[subj][book][chapter]){
    const tq = prompt('Enter total number of questions for this chapter (integer):'); if(!tq) return;
    const n = parseInt(tq); if(isNaN(n) || n<=0){ alert('Invalid number'); return; }
    examData.subjects[subj][book][chapter] = { totalQuestions: n, questions: {} };
  }
  populateSelectorsFromData();
});

document.getElementById('loadChapter').addEventListener('click', async ()=>{
  const ex = document.getElementById('examSelect').value; if(!ex) return alert('Select or add an exam first');
  current.exam = ex;
  current.subject = document.getElementById('subjectSelect').value || prompt('Enter subject:') || '';
  current.book = document.getElementById('bookSelect').value || prompt('Enter book:') || '';
  current.chapter = document.getElementById('chapterSelect').value || prompt('Enter chapter:') || '';
  if(!examData) await loadExamFile(current.exam);
  if(!ensureChapterExists()) return;
  renderTable();
});

document.getElementById('markAllCorrect').addEventListener('click', ()=> markAll('correct'));
document.getElementById('markAllWrong').addEventListener('click', ()=> markAll('wrong'));
document.getElementById('markAllNA').addEventListener('click', ()=> markAll('not_attempted'));
document.getElementById('newAttempt').addEventListener('click', ()=> newAttemptAll());
document.getElementById('showStatsBtn').addEventListener('click', ()=> showStats());

document.getElementById('syncBtn').addEventListener('click', async ()=>{
  // update exams.json
  try{
    const token = localStorage.getItem('qtracker_token');
    if(!token) return alert('Paste PAT in Settings first');
    let sha = null;
    const getRes = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}/exams.json?ref=${cfg.branch}`, { headers:{ 'Authorization':'token '+token,'Accept':'application/vnd.github.v3+json'} });
    if(getRes.status===200){ const j=await getRes.json(); sha=j.sha; }
    const content = JSON.stringify({ exams: examsList }, null, 2);
    const putRes = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}/exams.json`, {
      method:'PUT',
      headers:{ 'Authorization':'token '+token,'Accept':'application/vnd.github.v3+json'},
      body: JSON.stringify({ message: 'Update exams.json by QTracker', content: btoa(unescape(encodeURIComponent(content))), sha: sha, branch: cfg.branch })
    });
    if(putRes.status===201 || putRes.status===200) log('Updated exams.json');
    else log('Failed to update exams.json');
  }catch(err){ log('Sync exams.json failed: '+err.message); }

  // save current exam file if loaded
  if(current.exam && examData) {
    try{ await saveExamFile('Manual sync from QTracker'); } catch(e){ log('Save exam failed: '+e.message); }
  }
});

/* ========== Startup ========== */
(function init(){
  cfg = Object.assign(DEFAULT_CFG, cfg);
  // populate settings UI fields if open
  populateExamSelect();
  if(cfg.owner && cfg.repo && localStorage.getItem('qtracker_token')) loadExams();
  log('Ready. Open Settings to configure GitHub.');
})();
