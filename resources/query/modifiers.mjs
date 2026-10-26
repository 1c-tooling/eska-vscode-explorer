/** Controls collect values and core-provided source choices; no query keyword is assembled here. */
export function modifierForm(form,view,{element,button,labels:l,submit,close}){
  const value=view.value;
  /** A checkbox changes one typed flag and keeps unrelated modifier values intact. */
  function check(key,label,available=true){
    const wrapper=element('label',label),input=element('input');input.type='checkbox';input.name=key;input.checked=!!value[key];input.disabled=!view.editable||!available;
    input.addEventListener('change',()=>{value[key]=input.checked;});wrapper.append(input);form.append(wrapper);return input;
  }
  check('distinct',l.distinct);check('allowed',l.allowed);check('autoOrder',l.autoOrder,view.autoOrderAvailable);
  const label=element('label',l.top),top=element('input');top.type='number';top.name='top';top.min='0';top.max='4294967295';top.step='1';top.value=value.top===null?'':String(value.top);top.disabled=!view.editable;
  top.addEventListener('input',()=>{value.top=top.value===''?null:Number(top.value);});label.append(top);form.append(label);
  const lock=element('label',l.forUpdate),enabled=element('input');enabled.type='checkbox';enabled.name='forUpdate';enabled.checked=value.forUpdate!==null;enabled.disabled=!view.editable||!view.forUpdateAvailable;lock.append(enabled);form.append(lock);
  const sources=element('select');sources.multiple=true;sources.name='lockSources';sources.size=Math.min(6,Math.max(2,view.sources.length));sources.setAttribute('aria-label',l.lockSources);sources.disabled=!enabled.checked||enabled.disabled;
  for(const source of view.sources){const option=element('option',source);option.value=source;option.selected=value.forUpdate?.includes(source)??false;sources.append(option);}
  enabled.addEventListener('change',()=>{value.forUpdate=enabled.checked?[...sources.selectedOptions].map(option=>option.value):null;sources.disabled=!enabled.checked;});
  sources.addEventListener('change',()=>{value.forUpdate=[...sources.selectedOptions].map(option=>option.value);});form.append(sources,element('small',l.lockAllHint));
  const accept=button(l.previewChanges,()=>{},view.editable?null:'read_only');accept.type='submit';form.append(accept,button(l.close,close));
  form.addEventListener('submit',event=>{event.preventDefault();if(view.editable&&form.reportValidity())submit(value);});
}
