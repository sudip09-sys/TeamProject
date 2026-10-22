(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let username = 'guest';
  const read = key => { try { return Number(localStorage.getItem('nextstep-'+username+'-'+key)) || 0; } catch { return 0; } };
  const save = (key,value) => { try { localStorage.setItem('nextstep-'+username+'-'+key,String(value)); } catch { /* Games still work without browser storage. */ } };
  let mode='focus', remaining=25*60000, deadline=0, running=false, finishedMinutes=0, sessionMinutes=25, pendingLog=false;
  function drawTimer(){const seconds=Math.ceil(remaining/1000);$('timer-display').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');}
  function resetTimer(){running=false;remaining=Number($('timer-minutes').value)*60000;sessionMinutes=Number($('timer-minutes').value);$('timer-start').textContent='Start '+mode;$('timer-minutes').disabled=false;$('timer-status').textContent='Ready when you are.';drawTimer();}
  function tick(){if(!running)return;remaining=Math.max(0,deadline-Date.now());drawTimer();if(remaining===0){running=false;$('timer-minutes').disabled=false;$('timer-start').textContent='Start '+mode;$('timer-status').textContent=mode==='focus'?'Focus complete. Take a well-earned break.':'Break complete. Ready for your next step?';if(mode==='focus'){finishedMinutes=sessionMinutes;pendingLog=true;$('log-focus').hidden=false;}}}
  $('timer-start').onclick=()=>{
    if(running){remaining=Math.max(0,deadline-Date.now());running=false;$('timer-start').textContent='Resume '+mode;$('timer-status').textContent='Paused.';return;}
    const minutes=Number($('timer-minutes').value);if(!Number.isInteger(minutes)||minutes<1||minutes>180){$('timer-status').textContent='Choose 1–180 minutes.';return;}
    if(remaining<=0||!$('timer-minutes').disabled){sessionMinutes=minutes;remaining=minutes*60000;}
    if(pendingLog){$('timer-status').textContent='Save your completed session or reset before starting another.';return;}
    deadline=Date.now()+remaining;running=true;$('timer-minutes').disabled=true;$('timer-start').textContent='Pause';$('timer-status').textContent=mode==='focus'?'One task. Your full attention.':'Step away, stretch, and recharge.';
  };
  $('timer-reset').onclick=()=>{pendingLog=false;$('log-focus').hidden=true;resetTimer();};
  $('timer-minutes').onchange=()=>{if(!running&&Number.isInteger(Number($('timer-minutes').value))&&Number($('timer-minutes').value)>=1&&Number($('timer-minutes').value)<=180)resetTimer();};
  document.querySelectorAll('[data-timer-mode]').forEach(button=>button.onclick=()=>{mode=button.dataset.timerMode;document.querySelectorAll('[data-timer-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));$('timer-minutes').value=mode==='focus'?25:5;resetTimer();});
  $('log-focus').onclick=async()=>{if(!pendingLog)return;$('log-focus').disabled=true;const ok=await window.NextStep.logFocus(finishedMinutes);$('log-focus').disabled=false;if(ok){pendingLog=false;$('log-focus').hidden=true;}};
  setInterval(tick,250);document.addEventListener('visibilitychange',tick);
  let context=null, source=null, gain=null, filter=null, oscillators=[], soundPlaying=false, audioUrl=null;
  async function stopSound(){try{source?.stop();oscillators.forEach(o=>o.stop());if(context)await context.close();}catch{}context=null;source=null;oscillators=[];soundPlaying=false;$('sound-toggle').textContent='Play soundscape ▶';}
  async function startSound(){
    await stopSound();
    try{
      const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw new Error('Audio is not supported in this browser.');
      context=new Audio();await context.resume();gain=context.createGain();gain.gain.value=Number($('sound-volume').value)/100*.3;gain.connect(context.destination);
      const buffer=context.createBuffer(1,context.sampleRate*4,context.sampleRate), channel=buffer.getChannelData(0), kind=$('sound-type').value;
      let brown=0;for(let i=0;i<channel.length;i++){const white=Math.random()*2-1;brown=(brown+.02*white)/1.02;channel[i]=kind==='white'?white:kind==='rain'?(white*.6+brown*2):brown*3;}
      source=context.createBufferSource();source.buffer=buffer;source.loop=true;filter=context.createBiquadFilter();filter.type=kind==='rain'?'lowpass':kind==='cafe'?'bandpass':'allpass';filter.frequency.value=kind==='rain'?3500:650;filter.Q.value=.5;source.connect(filter);filter.connect(gain);source.start();
      if(kind==='cafe'){const hum=context.createOscillator(), soft=context.createGain();hum.frequency.value=120;soft.gain.value=.025;hum.connect(soft);soft.connect(gain);hum.start();oscillators.push(hum);}
      soundPlaying=true;$('sound-toggle').textContent='Stop soundscape ■';
    }catch(error){await stopSound();window.NextStep.notice(error.message,true);}
  }
  $('sound-toggle').onclick=()=>soundPlaying?stopSound():startSound();$('sound-type').onchange=()=>{if(soundPlaying)startSound();};$('sound-volume').oninput=()=>{if(gain&&context)gain.gain.setTargetAtTime(Number($('sound-volume').value)/100*.3,context.currentTime,.05);};
  $('music-file').onchange=()=>{const file=$('music-file').files[0];if(!file)return;if(file.type&&!file.type.startsWith('audio/')){window.NextStep.notice('Choose an audio file.',true);return;}$('music-player').pause();if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl=URL.createObjectURL(file);$('music-player').src=audioUrl;};
  $('music-player').onerror=()=>window.NextStep.notice('This audio file could not be played. Try MP3, WAV, or another supported audio format.',true);
  let cards=[],first=null,locked=false,moves=0,pairs=0,game=0;
  const symbols=['✿','☀','☕','♫','✦','☘'];
  function bestLabel(){const best=read('memory-best');$('memory-best').textContent=best?'Your personal best: '+best+' moves on this device.':'Match all pairs to set your personal best.';}
  function newMemory(){game++;cards=[...symbols,...symbols];for(let i=cards.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[cards[i],cards[j]]=[cards[j],cards[i]];}first=null;locked=false;moves=0;pairs=0;$('memory-score').textContent='0 moves · 0 / 6 pairs';$('memory-board').replaceChildren();cards.forEach((symbol,i)=>{const b=document.createElement('button');b.type='button';b.className='memory-card';b.textContent='?';b.dataset.index=i;b.setAttribute('aria-label','Reveal card '+(i+1));b.onclick=()=>flip(b);$('memory-board').append(b);});bestLabel();}
  function reveal(button){button.textContent=cards[Number(button.dataset.index)];button.classList.add('revealed');button.setAttribute('aria-label','Card '+(Number(button.dataset.index)+1)+': '+button.textContent);}
  function flip(button){if(locked||button.disabled||button===first)return;reveal(button);if(!first){first=button;return;}moves++;const other=first;first=null;if(other.textContent===button.textContent){pairs++;other.disabled=true;button.disabled=true;other.classList.add('matched');button.classList.add('matched');if(pairs===6){const best=read('memory-best');if(!best||moves<best)save('memory-best',moves);bestLabel();}}else{locked=true;const current=game;setTimeout(()=>{if(current!==game)return;[other,button].forEach(b=>{b.textContent='?';b.classList.remove('revealed');b.setAttribute('aria-label','Reveal card '+(Number(b.dataset.index)+1));});locked=false;},850);}$('memory-score').textContent=moves+' moves · '+pairs+' / 6 pairs'+(pairs===6?' · Garden complete!':'');}
  $('memory-new').onclick=newMemory;newMemory();
  const passage='Small steps make steady progress. Our team plans the work, shares ideas, and learns together. A clear goal and a little focus can turn a difficult project into something we understand. We test each change, help each other, and celebrate every finished task. Take a breath, find your rhythm, and keep moving forward. ';
  let typingEnd=0,typingStart=0,typingActive=false;
  $('typing-prompt').textContent=passage;
  function finishTyping(){typingActive=false;$('typing-input').disabled=true;const input=$('typing-input').value;let correct=0;for(let i=0;i<input.length;i++)if(input[i]===passage[i])correct++;const elapsed=Math.max(1,(Date.now()-typingStart)/1000), wpm=Math.round(correct/5/(elapsed/60)),accuracy=input.length?Math.round(correct/input.length*100):0;const best=read('typing-best');if(wpm>best)save('typing-best',wpm);$('typing-result').textContent=`${wpm} WPM · ${accuracy}% accuracy · Best: ${Math.max(best,wpm)} WPM`;$('typing-start').disabled=false;}
  $('typing-start').onclick=()=>{typingStart=Date.now();typingEnd=typingStart+60000;typingActive=true;$('typing-input').value='';$('typing-input').disabled=false;$('typing-input').maxLength=passage.length;$('typing-input').focus();$('typing-start').disabled=true;$('typing-result').textContent='60 seconds remaining';};
  $('typing-input').onpaste=event=>event.preventDefault();$('typing-input').oninput=()=>{if(typingActive&&$('typing-input').value.length>=passage.length)finishTyping();};
  setInterval(()=>{if(!typingActive)return;const left=Math.max(0,Math.ceil((typingEnd-Date.now())/1000));$('typing-result').textContent=left+' seconds remaining';if(!left)finishTyping();},250);
  const questions=[{q:'Which part of NextStep saves shared tasks permanently?',a:['The database','The CSS file','The browser tab'],correct:0,why:'SQLite stores shared records on the server’s persistent volume.'},{q:'What should happen before reviewed work becomes Done?',a:['The assignee approves it','The selected reviewer approves it','The browser is closed'],correct:1,why:'A separate reviewer checks the work and approves it.'},{q:'Why use a separate Git branch for a feature?',a:['To hide the project','To avoid testing','To develop and review changes separately'],correct:2,why:'A feature branch lets the team review a change before merging.'},{q:'What does a 409 conflict mean when editing a task?',a:['Someone changed the item since it was opened','The password is too short','The server cannot find the page'],correct:0,why:'Refresh and reopen the task to edit its latest version.'},{q:'What should you do with a recovery code?',a:['Post it on GitHub','Save it privately','Share it with everyone'],correct:1,why:'It can reset your password and should stay private.'},{q:'What does a prerequisite mean?',a:['An optional color','A task that must finish first','A team member'],correct:1,why:'Dependencies keep work in a sensible order and show what is blocked.'}];
  let question=0,answered=false,correctAnswers=0,answerCount=0;
  function drawQuiz(){answered=false;const item=questions[question];$('quiz-question').textContent=(question+1)+'. '+item.q;$('quiz-result').textContent=`This round: ${correctAnswers}/${answerCount} correct`;$('quiz-answers').replaceChildren();item.a.forEach((answer,index)=>{const b=document.createElement('button');b.textContent=answer;b.onclick=()=>{if(answered)return;answered=true;answerCount++;if(index===item.correct)correctAnswers++;$('quiz-answers').querySelectorAll('button').forEach(button=>button.disabled=true);$('quiz-result').textContent=(index===item.correct?'Correct! ':'Not quite. ')+item.why+` Score: ${correctAnswers}/${answerCount}`;};$('quiz-answers').append(b);});$('quiz-next').textContent=question===questions.length-1?'Start a new round ↻':'Next question →';}
  $('quiz-next').onclick=()=>{question=(question+1)%questions.length;if(question===0){correctAnswers=0;answerCount=0;}drawQuiz();};drawQuiz();
  window.addEventListener('nextstep-signin',event=>{username=event.detail;newMemory();question=0;correctAnswers=0;answerCount=0;drawQuiz();$('typing-result').textContent='Your best: '+read('typing-best')+' WPM on this device.';});
  window.addEventListener('nextstep-signout',()=>{pendingLog=false;finishedMinutes=0;$('log-focus').hidden=true;resetTimer();stopSound();$('music-player').pause();$('music-player').removeAttribute('src');if(audioUrl){URL.revokeObjectURL(audioUrl);audioUrl=null;}$('music-file').value='';typingActive=false;$('typing-input').disabled=true;$('typing-start').disabled=false;username='guest';newMemory();});
  window.addEventListener('pagehide',()=>{stopSound();$('music-player').pause();});
})();
