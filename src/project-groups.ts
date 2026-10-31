import type { ProjectTree } from "./tree.js";

type GroupType = "extension" | "report" | "processing";
export interface ProjectGroup {
  projectGroup: GroupType;
  key: string;
  projects: readonly ProjectTree[];
}

/** Group only the supplied visible members, retaining physical project identities and ordering. */
export class ProjectGroups {
  roots: (ProjectTree | ProjectGroup)[] = [];
  private readonly groups = new Map<GroupType, ProjectGroup>();
  private parents = new Map<ProjectTree, ProjectGroup>();

  constructor(readonly workspace: string) {}

  update(projects: readonly ProjectTree[]): void {
    const buckets = new Map<GroupType, ProjectTree[]>();
    for (const project of projects) {
      const type = this.groupType(project);
      if (!type) continue;
      const values = buckets.get(type) ?? [];
      values.push(project); buckets.set(type, values);
    }
    this.parents.clear(); this.roots = [];
    const emitted = new Set<GroupType>();
    for (const project of projects) {
      const type = this.groupType(project), members = type ? buckets.get(type)! : [];
      if (!type || members.length < 2) { this.roots.push(project); continue; }
      let group = this.groups.get(type);
      if (!group) {
        group = { projectGroup: type, key: JSON.stringify(["project-group", this.workspace, type]), projects: [] };
        this.groups.set(type, group);
      }
      group.projects = members; this.parents.set(project, group);
      if (!emitted.has(type)) { this.roots.push(group); emitted.add(type); }
    }
    for (const [type, group] of this.groups) if (!emitted.has(type)) group.projects = [];
  }

  parent(project: ProjectTree): ProjectGroup | undefined { return this.parents.get(project); }

  contains(group: ProjectGroup): boolean { return this.roots.includes(group); }

  private groupType(project: ProjectTree): GroupType | undefined {
    return project.info.scope.kind === "member" && project.info.type !== "configuration" ? project.info.type : undefined;
  }
}
