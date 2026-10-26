/** New nodes are input values; only ESKA formats or parses their query syntax. */
export function emptyPredicate(kind='compare') {
  if(kind==='all'||kind==='any')return {kind,children:[emptyPredicate()]};
  if(kind==='not')return {kind,child:emptyPredicate()};
  if(kind==='between')return {kind,expression:'',begin:'',end:''};
  if(kind==='isNull')return {kind,expression:'',negated:false};
  if(kind==='raw')return {kind,expression:''};
  return {kind:'compare',left:'',comparison:'equal',right:''};
}

/** Nested controls edit an explicitly bounded predicate tree, never a SQL string assembled in the IDE. */
export function predicateForm(form, initial, {element,button,input,select,labels:l,draw,update}) {
  const labels={all:l.booleanAll,any:l.booleanAny,not:l.booleanNot,compare:l.comparison,between:l.between,isNull:l.isNull,raw:l.rawExpression};
  /** Recursion follows the checked DTO; changing shape creates only an ordinary input node. */
  function row(value,set,depth=0){
    const group=element('fieldset',undefined,'predicate-node');group.dataset.kind=value.kind;
    const picker=select(group,l.conditionKind,'predicateKind',{predicateKind:value.kind},Object.entries(labels));
    picker.addEventListener('change',()=>{set(emptyPredicate(picker.value));draw();});
    if(value.kind==='all'||value.kind==='any'){
      for(const [index,child] of value.children.entries()){
        const node=row(child,next=>{value.children[index]=next;},depth+1);
        node.append(button(l.remove,()=>{value.children.splice(index,1);draw();},value.children.length<2?'required_item':null));group.append(node);
      }
      group.append(button(l.add,()=>{value.children.push(emptyPredicate());draw();},depth>=30?'model_limit':null));
    }else if(value.kind==='not')group.append(row(value.child,next=>{value.child=next;},depth+1));
    else if(value.kind==='compare'){
      input(group,l.leftField,'left',value);select(group,l.comparison,'comparison',value,[['equal','='],['notEqual','<>'],['less','<'],['lessOrEqual','<='],['greater','>'],['greaterOrEqual','>='],['like',l.comparisonLike],['in',l.comparisonIn],['inHierarchy',l.comparisonInHierarchy]]);input(group,l.rightValue,'right',value);
    }else{
      input(group,l.expression,'expression',value);
      if(value.kind==='between'){input(group,l.rangeBegin,'begin',value);input(group,l.rangeEnd,'end',value);}
      if(value.kind==='isNull'){const check=element('input');check.type='checkbox';check.checked=value.negated;check.setAttribute('aria-label',l.booleanNot);check.addEventListener('change',()=>{value.negated=check.checked;});group.append(check);}
    }
    return group;
  }
  form.append(row(initial,update));
}
