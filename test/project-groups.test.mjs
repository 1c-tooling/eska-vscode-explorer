import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectGroups } from "../out/project-groups.js";
import { message } from "../out/messages.js";

function member(type, name, kind="member") {
  return { key:name, info:{ type, scope:kind==="member"?{kind,name}:{kind} } };
}

test("each visible member type has its own threshold and preserves backend ordering", () => {
  const groups=new ProjectGroups("workspace"), config=member("configuration","base"), one=member("extension","one"),
    report=member("report","report"), processing=member("processing","processing"), two=member("extension","two");
  groups.update([config,one,report,processing]);
  assert.deepEqual(groups.roots,[config,one,report,processing]);
  groups.update([config,one,report,two,processing]);
  const extension=groups.parent(one);
  assert.equal(extension.projectGroup,"extension");assert.deepEqual(extension.projects,[one,two]);
  assert.deepEqual(groups.roots,[config,extension,report,processing]);assert.equal(groups.parent(two),extension);
  const report2=member("report","report2"), processing2=member("processing","processing2");
  groups.update([config,one,report,two,processing,report2,processing2]);
  assert.deepEqual(groups.roots.map(row=>row.projectGroup??row.key),["base","extension","report","processing"]);
  assert.equal(groups.parent(config),undefined);
  assert.deepEqual(groups.parent(report).projects,[report,report2]);
  assert.deepEqual(groups.parent(processing).projects,[processing,processing2]);
});

test("one-to-two transitions preserve project and group identities without stale or duplicate rows", () => {
  const groups=new ProjectGroups("workspace"), first=member("extension","first"), second=member("extension","second");
  groups.update([first,second]);const group=groups.parent(first), key=group.key;
  groups.update([first]);assert.deepEqual(groups.roots,[first]);assert.equal(groups.parent(first),undefined);
  assert.equal(groups.contains(group),false);assert.deepEqual(group.projects,[]);
  groups.update([]);assert.deepEqual(groups.roots,[]);
  groups.update([first,second]);assert.equal(groups.parent(first),group);assert.equal(group.key,key);
  const restarted=new ProjectGroups("workspace");restarted.update([first,second]);assert.equal(restarted.parent(first).key,key);
  const other=new ProjectGroups("other workspace");other.update([first,second]);assert.notEqual(other.parent(first).key,key);
});

test("standalone projects and directory names cannot create virtual member groups", () => {
  const groups=new ProjectGroups("workspace"), standalone=member("report","Reports","standalone"), memberReport=member("report","extensions");
  groups.update([standalone,memberReport]);assert.deepEqual(groups.roots,[standalone,memberReport]);
  assert.equal(groups.parent(standalone),undefined);assert.equal(groups.parent(memberReport),undefined);
});

test("all three virtual labels are available in both supported locales", () => {
  const keys=["projectExtensions","projectReports","projectProcessors"];
  assert.deepEqual(keys.map(key=>message("ru-RU",key)),["Расширения","Отчеты","Обработки"]);
  assert.deepEqual(keys.map(key=>message("en-US",key)),["Extensions","Reports","Data processors"]);
});
