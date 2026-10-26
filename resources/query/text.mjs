/** Highlight core-provided UTF-16 ranges without interpreting or injecting query markup. */
export function markedText(node,text,range){
  node.replaceChildren();
  if(!range){node.textContent=text;return;}
  const mark=document.createElement('mark');mark.className='linked-fragment';mark.textContent=text.slice(range.start,range.end);
  node.append(document.createTextNode(text.slice(0,range.start)),mark,document.createTextNode(text.slice(range.end)));
}

/** A child dialog prevents interactive parent edits and has keyboard close/focus containment. */
export function mountDialog(root,dialog,close){
  dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
  for(const child of root.querySelectorAll(':scope > *'))child.inert=true;
  root.append(dialog);
  dialog.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();close();}
    if(event.key==='Tab'){
      const controls=[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(node=>node.getClientRects().length);
      const next=controls[(controls.indexOf(document.activeElement)+(event.shiftKey?-1:1)+controls.length)%controls.length];
      if(next){event.preventDefault();next.focus();}
    }
  });
  queueMicrotask(()=>{if(!dialog.inert&&!dialog.contains(document.activeElement))dialog.querySelector('textarea,button:not(:disabled),[tabindex="0"]')?.focus();});
}

/** The editable buffer is private input; only an explicit core preview can turn it into a model. */
export function textEditor(buffer,{element,button,labels:l,submit,close,maxBytes,busy}){
  const dialog=element('form',undefined,'text-editor');dialog.setAttribute('aria-label',l.editText);dialog.append(element('h2',l.editText));
  const input=element('textarea');input.name='queryTextBuffer';input.value=buffer.text;input.spellcheck=false;input.setAttribute('aria-label',l.text);input.disabled=busy;input.maxLength=maxBytes;
  input.addEventListener('input',()=>{buffer.text=input.value;input.setCustomValidity('');});dialog.append(input);
  const accept=button(l.previewChanges,()=>{},null,'text-accept');accept.type='submit';dialog.append(accept,button(l.close,close,null,'text-cancel'));
  dialog.addEventListener('submit',event=>{event.preventDefault();if(new TextEncoder().encode(input.value).length>maxBytes)input.setCustomValidity(l.textLimit);if(!busy&&dialog.reportValidity())submit(input.value,buffer.revision);});
  input.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();dialog.requestSubmit();}});return dialog;
}
