export interface WorkspaceFileNode {
  children?: WorkspaceFileNode[];
  dir: boolean;
  name: string;
  open?: boolean;
  path: string;
  status?: string;
}

export const parseGitStatus = (output: string) =>
  output
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      file: line.slice(3).split(" -> ").pop() ?? line.slice(3),
      xy: line.slice(0, 2),
    }));

export const buildChangedFileTree = (
  cwd: string,
  files: { file: string; xy: string }[]
): WorkspaceFileNode[] => {
  const root: WorkspaceFileNode[] = [];
  for (const { file, xy } of files) {
    const parts = file.split("/");
    let nodes = root;
    let path = cwd;
    for (const [index, name] of parts.entries()) {
      path = `${path}/${name}`;
      let node = nodes.find((item) => item.name === name);
      if (!node) {
        node = {
          dir: index < parts.length - 1,
          name,
          open: true,
          path,
          status: index === parts.length - 1 ? xy : undefined,
        };
        nodes.push(node);
      }
      node.children ??= [];
      nodes = node.children;
    }
  }
  return root;
};
