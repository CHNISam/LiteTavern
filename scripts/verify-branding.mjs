
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const retiredBrand = ['pom', 'chat'].join('');
const repositoryFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {
  encoding: 'utf8'
  }
)
  .split('\0')
  .filter((file) => file && existsSync(file));

const violations = [];

for (const file of repositoryFiles) {
  if (file.toLowerCase().includes(retiredBrand)) {
    violations.push(`${file}: retired brand in path`);
  }

  const content = readFileSync(file);
  const utf8 = content.toString('utf8');
  const utf16le = content.toString('utf16le');

  if (
    utf8.toLowerCase().includes(retiredBrand) ||
    utf16le.toLowerCase().includes(retiredBrand)
  ) {
    violations.push(`${file}: retired brand in content`);
  }
}

if (violations.length > 0) {
  console.error('LiteTavern branding policy failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log('LiteTavern branding policy passed.');
}
