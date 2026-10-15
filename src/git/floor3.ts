// The branch `floor-3`. It exists on every repository, is identical everywhere (same object ids)
// and is never stored: its objects are built in memory once per isolate and served by
// ObjectStore as a fallback. It is never listed in the UI (see refs.ts listVisibleBranches).

import {
  hashObject,
  serializeCommit,
  serializeTree,
  utf8,
  type GitObject,
  type Person,
  type TreeEntry,
} from './objects';

export const FLOOR3_BRANCH = 'floor-3';
export const FLOOR3_REF = 'refs/heads/floor-3';

const KEVIN: Person = { name: 'Kevin', email: 'Kevin@southbag.cc', time: 1561939200, tz: '+1000' };

const FILES: Record<string, string> = {
  'README.md': `# Floor 3

Southbag has no Floor 3.

The office key card labelled Floor 3 is decorative.

The lift button is a manufacturing error.

The additional network traffic is unrelated.

The voices reported near the stairwell are caused by ventilation.
`,
  'keycard.txt': 'The office key card labelled Floor 3 is decorative.\n',
  'lift/button-3.txt': 'The lift button is a manufacturing error.\n',
  'network/traffic.log': `2019-06-28T01:12:04+10:00 rack F3-01 -> 10.3.3.3 tcp/5060 1.2 GB
2019-06-28T01:47:19+10:00 rack F3-01 -> 10.3.3.3 tcp/5060 1.2 GB
2019-06-28T02:22:51+10:00 rack F3-01 -> 10.3.3.3 udp/16384 0.8 GB
2019-06-28T03:05:33+10:00 rack F3-01 -> 10.3.3.3 tcp/5060 1.2 GB
2019-06-28T03:41:02+10:00 rack F3-01 -> 10.3.3.3 udp/16384 0.9 GB
2019-06-29T00:58:47+10:00 rack F3-01 -> 10.3.3.3 tcp/5060 1.2 GB
2019-06-29T02:14:10+10:00 rack F3-01 -> 10.3.3.3 udp/16384 1.1 GB
2019-06-29T04:30:26+10:00 rack F3-01 -> 10.3.3.3 tcp/5060 1.2 GB
2019-06-30T01:03:55+10:00 rack F3-01 -> 10.3.3.3 tcp/5060 1.2 GB
2019-06-30T23:59:59+10:00 rack F3-01 -> 10.3.3.3 udp/16384 1.2 GB
The additional network traffic is unrelated.
`,
  'stairwell/voices.txt': 'The voices reported near the stairwell are caused by ventilation.\n',
  'rack/F3-01/inventory.txt': `Rack F3-01 inventory

1. Polycom SoundPoint IP 355 uplink (ethernet, 1 port, cable runs off-site)
2. Yealink SIP-T58W
3. Kevin's office light controller (always on)
`,
};

export interface Floor3 {
  commit: string;
  tree: string;
  objects: Map<string, GitObject>;
}

let built: Promise<Floor3> | null = null;

async function build(): Promise<Floor3> {
  const objects = new Map<string, GitObject>();
  const add = async (obj: GitObject) => {
    const oid = await hashObject(obj.type, obj.data);
    objects.set(oid, obj);
    return oid;
  };
  type Dir = { files: Map<string, string>; dirs: Map<string, Dir> };
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, content] of Object.entries(FILES)) {
    const parts = path.split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      if (!dir.dirs.has(p)) dir.dirs.set(p, { files: new Map(), dirs: new Map() });
      dir = dir.dirs.get(p)!;
    }
    dir.files.set(parts[parts.length - 1], content);
  }
  const writeDir = async (dir: Dir): Promise<string> => {
    const entries: TreeEntry[] = [];
    for (const [name, content] of dir.files) {
      entries.push({ mode: '100644', name, oid: await add({ type: 'blob', data: utf8(content) }) });
    }
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: await writeDir(sub) });
    return add({ type: 'tree', data: serializeTree(entries) });
  };
  const tree = await writeDir(root);
  const commit = await add({
    type: 'commit',
    data: serializeCommit({ tree, parents: [], author: KEVIN, committer: KEVIN, message: 'There is no Floor 3.\n' }),
  });
  return { commit, tree, objects };
}

/** The floor-3 objects, computed lazily once per isolate. */
export function getFloor3(): Promise<Floor3> {
  return (built ??= build());
}

export const isFloor3Ref = (name: string): boolean =>
  name === FLOOR3_REF || name === FLOOR3_BRANCH || name === 'heads/floor-3';
