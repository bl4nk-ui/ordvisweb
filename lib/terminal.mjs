import readline from 'node:readline';
export function readLine(prompt,hidden=false){
 return new Promise((resolve,reject)=>{
  if(!process.stdin.isTTY){reject(new Error('Parola kurulumu için VS Code veya bilgisayar terminalinizi kullanın.'));return;}
  readline.emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();let value='';
  const cleanup=()=>{process.stdin.off('keypress',handler);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};
  const handler=(str,key={})=>{
   if(key.ctrl&&key.name==='c'){cleanup();reject(new Error('Kurulum iptal edildi.'));return;}
   if(key.name==='return'||key.name==='enter'){cleanup();resolve(value);return;}
   if(key.name==='backspace'){if(value){value=[...value].slice(0,-1).join('');process.stdout.write('\b \b');}return;}
   if(str&&!key.ctrl&&!key.meta&&!/\p{C}/u.test(str)){value+=str;process.stdout.write(hidden?'*'.repeat([...str].length):str);}
  };
  process.stdin.on('keypress',handler);process.stdout.write(prompt);
 });
}
