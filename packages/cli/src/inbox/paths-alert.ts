/**
 * The reviewer's own paths: a pull request touching one of them needs them now, whatever the agent
 * made of the review. Where `alertWhen` asks an agent to judge, this is a fact about the diff and
 * cannot be misjudged.
 */
export function alertForPaths(files: { path: string }[], globs: string[]): string | null {
  if (globs.length === 0 || files.length === 0) {
    return null;
  }
  const patterns = globs.map(globToRegExp);
  const matched = files.filter(file => patterns.some(pattern => pattern.test(file.path)));
  if (matched.length === 0) {
    return null;
  }
  return `touches ${matched[0].path}${matched.length > 1 ? ` and ${matched.length - 1} more` : ''}`;
}

/**
 * The glob dialect a reviewer would expect of a path list: `**` spans directories, `*` and `?` stay
 * within one segment, everything else is literal. `node:path`'s own `matchesGlob` would do this,
 * but it still warns as experimental on the Node versions this runs on.
 */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        // Any number of directories, the pattern's own next segment included at any depth.
        i++;
        source += '(?:[^/]*/)*';
      } else if (source.endsWith('/')) {
        // A trailing `dir/**`: the directory itself and everything under it.
        source = `${source.slice(0, -1)}(?:/.*)?`;
      } else {
        source += '.*';
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`);
}
