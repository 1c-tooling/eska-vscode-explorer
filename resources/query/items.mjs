/** Selection is UI state; indices and all text transformations belong to the supplied core snapshot. */
export function selectItems(current, index, anchor, extend, toggle, indices) {
  if (extend && indices.includes(anchor)) {
    const a = indices.indexOf(anchor), b = indices.indexOf(index);
    return indices.slice(Math.min(a, b), Math.max(a, b) + 1);
  }
  if (toggle) return current.includes(index) ? current.filter(value => value !== index) : [...current, index].sort((a, b) => a - b);
  return [index];
}

/** Render checked values as cells, without parsing expressions or remapping query identities. */
export function itemTable(entries, context) {
  const { element, button, labels: l, selected, choose, run, edit, compose, navigate, writable, busy } = context;
  const wrap = element('div', undefined, 'item-table'), toolbar = element('div', undefined, 'item-toolbar controls');
  toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', l.selection);
  const active = entries.filter(row => selected.includes(row.item.index));
  const reason = operation => !writable ? 'read_only' : !active.length ? 'single_item' : active.map(row => row.item.unavailable[operation]).find(Boolean);
  const first = active[0], last = active.at(-1);
  toolbar.append(button(l.edit, () => edit(first), active.length !== 1 ? 'single_item' : reason('replace'), 'edit-selected'));
  toolbar.append(button(l.remove, () => run({kind:'remove'}), reason('remove'), 'remove-selected'));
  toolbar.append(button(l.copy, () => run({kind:'copy', to: entries[0]?.clause.items.length ?? 0}), reason('copy'), 'copy-selected'));
  toolbar.append(button('↑', () => run({kind:'move', to:first.item.index - 1}), !first || first.item.index === 0 ? 'single_item' : reason('move'), 'move-selected-up'));
  toolbar.append(button('↓', () => run({kind:'move', to:last.item.index + 2}), !last || last.item.index + 1 === last.clause.items.length ? 'single_item' : reason('move'), 'move-selected-down'));
  if(context.linkedText)toolbar.append(button(l.showInText,()=>context.locate(first),active.length===1?null:"single_item","show-in-text"));
  wrap.append(toolbar);
  const table = element('table'); table.setAttribute('aria-label', l.selection); table.setAttribute('aria-multiselectable','true');
  const head = element('thead'), tr = element('tr'), check = element('input'); check.type='checkbox'; check.setAttribute('aria-label',l.selectAll);
  check.checked = !!entries.length && active.length === entries.length; check.indeterminate = !!active.length && !check.checked; check.disabled = busy;
  check.addEventListener('change', () => choose(check.checked ? entries.map(row => row.item.index) : []));
  const th = element('th'); th.append(check); tr.append(th,element('th', l.expression),element('th', l.alias),element('th', l.aggregate),element('th',l.comments)); head.append(tr); table.append(head);
  const body = element('tbody');
  for (const row of entries) {
    const { item }=row, value=item.visual, tr=element('tr'); tr.dataset.item=String(item.index); tr.tabIndex=selected.includes(item.index)?0:-1; tr.setAttribute('aria-selected',String(selected.includes(item.index)));
    const selectRow = event => choose(selectItems(selected,item.index,context.anchor,event.shiftKey,event.ctrlKey||event.metaKey,entries.map(row=>row.item.index)),item.index);
    const tick=element('input'); tick.type='checkbox'; tick.checked=selected.includes(item.index); tick.setAttribute('aria-label',`${l.selection} ${item.index+1}`); tick.disabled=busy;
    tick.addEventListener('click',event=>{event.stopPropagation();choose(selectItems(selected,item.index,context.anchor,event.shiftKey,true,entries.map(row=>row.item.index)),item.index);});
    const td=element('td'); td.append(tick); tr.append(td);
    for (const key of ['expression','alias','aggregate']) {
      const cell=element('td'), cellValue=key==='expression'?(value?.expression ?? value?.table ?? item.preview):value?.[key];
      const display=element('button', key==='aggregate'&&cellValue?l[cellValue]:String(cellValue??''),'cell-value'); display.type='button'; display.title=String(cellValue??''); display.setAttribute('aria-label',`${l[key]} ${item.index+1}`);
      const openCell=()=> {
        if (!writable || busy || item.unavailable.replace) return;
        if (!value || !(key in value) || typeof value[key]==='boolean') { edit(row); return; }
        const input=element(key==='aggregate'?'select':'input'); input.name=`cell-${key}`; input.setAttribute('aria-label',l[key]);
        if (key==='aggregate') for (const name of ['','sum','count','minimum','maximum','average']) { const option=element('option',name?l[name]:l.noAggregate);option.value=name; input.append(option); }
        input.value=value[key]??'';
        const accept=()=> { const expression=structuredClone(value); expression[key]=key==='aggregate'?(input.value||null):input.value; compose(expression,row.selection); };
        input.addEventListener('keydown',event=>{ if(event.key==='Enter'){event.preventDefault();accept();} if(event.key==='Escape'){event.preventDefault();context.cells.delete(`${row.selection.statement}:${row.selection.clause}:${item.index}:${key}`);cell.replaceChildren(display);} });
        input.addEventListener('input',()=>context.cells.set(`${row.selection.statement}:${row.selection.clause}:${item.index}:${key}`,input.value));
        input.value=context.cells.get(`${row.selection.statement}:${row.selection.clause}:${item.index}:${key}`)??input.value;
        cell.replaceChildren(input); input.focus(); if(input.select)input.select();
      };
      display.addEventListener('dblclick',openCell); display.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key==='F2'){event.preventDefault();openCell();}});
      cell.append(display); tr.append(cell);
      if(context.cells.has(`${row.selection.statement}:${row.selection.clause}:${item.index}:${key}`))openCell();
    }
    const comments=element('td');if(item.comments)comments.append(context.linkedText?button(String(item.comments),()=>context.comments(row),null,'item-comments'):element('span',String(item.comments)));
    for (const child of item.children??[]) comments.append(button(l.editNested,()=>navigate(child),null,'edit-nested'));
    tr.append(comments); tr.addEventListener('click',event=>{if(event.target===tr)selectRow(event);});
    tr.addEventListener('keydown',event=> {
      if(event.target!==tr && event.target!==tick)return;
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();choose(entries.map(row=>row.item.index));}
      else if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)&&!reason('move')){event.preventDefault();if(event.key==='ArrowUp'&&first?.item.index>0)run({kind:'move',to:first.item.index-1});if(event.key==='ArrowDown'&&last?.item.index+1<last.clause.items.length)run({kind:'move',to:last.item.index+2});}
      else if(event.key==='Delete'&&!reason('remove')){event.preventDefault();run({kind:'remove'});}
      else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'&&!reason('copy')){event.preventDefault();run({kind:'copy',to:row.clause.items.length});}
      else if(event.key==='Enter')edit(row);
    });
    tr.draggable=writable&&!busy&&!item.unavailable.move;
    tr.addEventListener('dragstart',event=> { const set=selected.includes(item.index)?selected:[item.index]; choose(set,item.index,false); event.dataTransfer.setData('application/x-eska-items',JSON.stringify({clause:row.selection.clause,statement:row.selection.statement,items:set})); });
    tr.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('application/x-eska-items')&&writable)event.preventDefault();});
    tr.addEventListener('drop',event=>{event.preventDefault();try{const data=JSON.parse(event.dataTransfer.getData('application/x-eska-items'));if(data.statement===row.selection.statement&&data.clause===row.selection.clause)run({kind:'move',to:item.index},data.items);}catch{ /* Foreign drag data has no authority. */ }});
    body.append(tr);
  }
  table.append(body); wrap.append(table); return wrap;
}
