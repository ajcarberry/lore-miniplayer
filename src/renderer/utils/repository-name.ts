// Validate folder name - no special characters, no reserved Windows names
export function validateRepositoryName(name: string): string | null {
  if (!name) {
    return 'Repository name is required';
  }
  if (name.length > 255) {
    return 'Name too long';
  }

  const invalidChars = /[<>:"/\\|?*]/;
  if (invalidChars.test(name)) {
    return 'Name contains invalid characters';
  }

  const reservedNames = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
  if (reservedNames.test(name)) {
    return 'This is a reserved system name';
  }

  return null;
}

// Sanitize repository name by extracting the basename (last path component)
export async function sanitizeRepositoryName(name: string): Promise<string> {
  const result = await window.electronAPI.path.basename(name);
  return result.success ? result.data : name;
}
