const api = acquireVsCodeApi();
let plan, stale = false;
const get = id => document.getElementById(id);
/** Workspace data only reaches text nodes; no source snippet is interpreted as HTML. */
function text(tag, value, className = "") {
  const node = document.createElement(tag); node.textContent = value; node.className = className; return node;
}
/** Keep confirmation explicit when uncertain locations are left for manual inspection. */
function update() { get("apply").disabled = !plan || stale || plan.issues.length > 0 || (plan.files.some(file => file.uncertain.length) && !get("reviewed").checked); }
get("reviewed").addEventListener("change", update);
get("apply").addEventListener("click", () => { if (!get("apply").disabled) api.postMessage({ type: "apply", reviewed: get("reviewed").checked }); });
get("cancel").addEventListener("click", () => api.postMessage({ type: "cancel" }));
window.addEventListener("message", event => {
  if (event.data.type === "error") { get("notice").textContent = event.data.text; stale = true; update(); return; }
  if (event.data.type !== "plan") return;
  const labels = event.data.labels; plan = event.data.plan;
  get("title").textContent = `${plan.oldName} → ${plan.newName}`;
  const changes = plan.files.reduce((count, file) => count + file.replacements.length, 0);
  const uncertain = plan.files.reduce((count, file) => count + file.uncertain.length, 0);
  get("summary").textContent = labels.renameSummary.replace("{0}", String(changes)).replace("{1}", String(plan.moves.length)).replace("{2}", String(uncertain));
  get("review-label").textContent = labels.renameReviewed;
  get("reviewed").parentElement.hidden = uncertain === 0;
  get("apply").textContent = labels.renameApply; get("cancel").textContent = labels.propertyCancel;
  for (const id of ["issues", "moves", "files"]) get(id).replaceChildren();
  if (plan.issues.length) {
    get("issues").append(text("h2", labels.renameBlocked));
    for (const issue of plan.issues) get("issues").append(text("p", `${issue.path || plan.oldName} · ${issue.caption}`));
  }
  if (plan.moves.length) {
    get("moves").append(text("h2", labels.renameMoves));
    for (const move of plan.moves) get("moves").append(text("p", `${move.from} → ${move.to}`, "path"));
  }
  plan.files.forEach((file, fileIndex) => {
    const section = document.createElement("details"); section.open = plan.files.length <= 8;
    section.append(text("summary", `${file.path} · ${file.replacements.length} / ${file.uncertain.length}`));
    let rendered = false;
    const renderFile = () => {
      if (rendered || !section.open) return;
      rendered = true;
    for (const [items, isUncertain] of [[file.replacements, false], [file.uncertain, true]]) {
      if (items.length) section.append(text("h3", labels[isUncertain ? "renameUncertain" : "renameChanges"]));
      items.forEach((item, index) => {
        const row = text("div", "", "change");
        row.append(text("pre", isUncertain ? item.text : item.before, isUncertain ? "uncertain" : "before"));
        if (!isUncertain) row.append(text("pre", item.after, "after"));
        const button = text("button", labels.renameOpenLocation); button.type = "button";
        button.addEventListener("click", () => api.postMessage({ type: "open", file: fileIndex, index, uncertain: isUncertain }));
        row.append(button); section.append(row);
      });
    }
    };
    section.addEventListener("toggle", renderFile); renderFile();
    get("files").append(section);
  });
  update();
});
api.postMessage({ type: "ready" });
