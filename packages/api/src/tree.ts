export interface TreeEntry {
  type: 'blob' | 'tree';
  path: string;
  name: string;
}

export interface TreePathsResponse {
  paths: string[];
}

export interface TreeEntriesResponse {
  entries: TreeEntry[];
}

export interface TreeFingerprintResponse {
  fingerprint: string;
}
