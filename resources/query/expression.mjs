/** Text controls use native UTF-16 selection; ESKA still validates the entire resulting expression. */
export function insertAtSelection(control, value) {
  const start=control.selectionStart??control.value.length,end=control.selectionEnd??start;
  control.setRangeText(value,start,end,'end');control.dispatchEvent(new Event('input',{bubbles:true}));control.focus();
}

/** One contextual field picker serves operands, grouping, ordering, totals and virtual arguments. */
export function expressionTools(form, {element,button,labels:l,fields,state}) {
  const controls=[...form.querySelectorAll('input:not([type=checkbox]),textarea')].filter(node=>!['alias','table','name'].includes(node.name));
  if(!controls.length)return;
  // Only the owning form retains this picker state; another editor starts with its own values.
  let target=controls[state.target]??controls[0];
  for(const [index,control] of controls.entries()) {
    control.addEventListener('focus',()=>{target=control;state.target=index;});
  }
  const tools=element('details',undefined,'expression-tools');tools.append(element('summary',l.insertField));
  const search=element('input');search.type='search';search.value=state.search??'';
  search.setAttribute('aria-label',l.search);tools.append(search);
  const choices=element('div',undefined,'expression-choices');tools.append(choices);
  /** Search changes presentation only; field expressions have already been qualified by ESKA. */
  function draw(){
    choices.replaceChildren();
    const query=search.value.toLocaleLowerCase();
    for(const value of fields.filter(value=>value.toLocaleLowerCase().includes(query)).slice(0,100)) {
      choices.append(button(value,()=>insertAtSelection(target,value),null,'insert-expression-field'));
    }
  }
  search.addEventListener('input',()=>{state.search=search.value;draw();});draw();form.append(tools);
}
